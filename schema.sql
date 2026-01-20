-- smart_warehouse schema.sql (FULL) - aligned with Smart Warehouse Node/ESP32 project
-- MySQL 8+ | utf8mb4 | InnoDB
-- Includes: cells (3x4 + IR pins), products (RFID + strategies), operations, auto_tasks,
-- loading_zone (ultrasonic+servo), conveyor_status, sensor_events, inventory_history,
-- sensor_calibration, system_settings, admins + useful views.
-- Safe to run on a fresh DB (drops and recreates).
USE smart_warehouse;

ALTER TABLE operations
  MODIFY op_type VARCHAR(50) NOT NULL;

ALTER TABLE auto_tasks
  MODIFY task_type VARCHAR(50) NOT NULL;


DROP DATABASE IF EXISTS smart_warehouse;
CREATE DATABASE IF NOT EXISTS smart_warehouse
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE smart_warehouse;

SET sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- =========================================================
-- ADMINS
-- =========================================================
CREATE TABLE admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- =========================================================
-- PRODUCTS
-- =========================================================
CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  sku VARCHAR(100) NULL,
  rfid_uid VARCHAR(100) UNIQUE NULL,
  weight_grams INT NULL,
  category VARCHAR(50) NULL,
  auto_assign BOOLEAN DEFAULT TRUE,

  storage_strategy ENUM('NEAREST_EMPTY', 'AI_OPTIMIZED', 'FIXED') DEFAULT 'NEAREST_EMPTY',
  fixed_row INT NULL,
  fixed_col INT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_sku (sku),
  INDEX idx_rfid (rfid_uid),
  INDEX idx_strategy (storage_strategy)
) ENGINE=InnoDB;

-- =========================================================
-- CELLS (3 rows x 4 cols) + IR SENSOR PIN PER CELL
-- =========================================================
CREATE TABLE cells (
  id INT AUTO_INCREMENT PRIMARY KEY,
  row_num INT NOT NULL,
  col_num INT NOT NULL,
  label VARCHAR(50) NOT NULL,

  ir_sensor_pin INT NOT NULL,
  sensor_status ENUM('ACTIVE', 'INACTIVE', 'ERROR') DEFAULT 'ACTIVE',
  last_sensor_check TIMESTAMP NULL,

  status ENUM('EMPTY', 'OCCUPIED', 'RESERVED', 'MAINTENANCE') DEFAULT 'EMPTY',
  product_id INT NULL,
  -- Quick UI cache (server still treats products table as source of truth)
  rfid_uid_cache VARCHAR(100) NULL,
  product_name_cache VARCHAR(100) NULL,
  quantity INT DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_row_col (row_num, col_num),
  UNIQUE KEY uq_ir_pin (ir_sensor_pin),
  INDEX idx_status (status),
  INDEX idx_product (product_id),
  INDEX idx_sensor (sensor_status),

  CONSTRAINT fk_cells_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- LOADING ZONE (Ultrasonic + Servo)
-- =========================================================
CREATE TABLE loading_zone (
  id INT PRIMARY KEY DEFAULT 1,
  product_id INT NULL,
  quantity INT DEFAULT 0,

  -- UI cache (helps show RFID/name even if product created on the fly)
  rfid_uid_cache VARCHAR(100) NULL,
  product_name_cache VARCHAR(100) NULL,

  ultrasonic_distance INT NULL,
  servo_position INT DEFAULT 90,

  status ENUM('EMPTY', 'OCCUPIED', 'PROCESSING') DEFAULT 'EMPTY',
  last_checked TIMESTAMP NULL,

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_status (status),
  CONSTRAINT fk_loading_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- CONVEYOR STATUS
-- =========================================================
CREATE TABLE conveyor_status (
  id INT PRIMARY KEY DEFAULT 1,
  has_product BOOLEAN DEFAULT FALSE,
  product_id INT NULL,
  product_rfid VARCHAR(100) NULL,

  mode ENUM('AUTO', 'MANUAL') DEFAULT 'AUTO',
  state ENUM('IDLE', 'MOVE_12CM', 'WAIT_RFID', 'MOVING_TO_LDR2', 'STOPPED', 'MANUAL_MODE') DEFAULT 'IDLE',
  last_detected_at TIMESTAMP NULL,

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_conveyor_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- SYSTEM SETTINGS (single row)
-- =========================================================
CREATE TABLE system_settings (
  id INT PRIMARY KEY DEFAULT 1,

  storage_strategy ENUM('NEAREST_EMPTY', 'AI_OPTIMIZED', 'FIXED') DEFAULT 'NEAREST_EMPTY',
  auto_mode BOOLEAN DEFAULT FALSE,
  conveyor_manual_control BOOLEAN DEFAULT FALSE,

  loading_zone_auto_close BOOLEAN DEFAULT TRUE,
  ir_sensor_auto_update BOOLEAN DEFAULT TRUE,

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- =========================================================
-- OPERATIONS (used by Node: /api/operations)
-- =========================================================
CREATE TABLE operations (
  id INT AUTO_INCREMENT PRIMARY KEY,

  op_type ENUM(
    'HOME',
    'PICK_FROM_CONVEYOR',
    'PLACE_IN_CELL',
    'TAKE_FROM_CELL',
    'GOTO_COLUMN',
    'MANUAL_CMD',
    'MOVE_TO_LOADING',
    'RETURN_TO_LOADING',
    'AUTO_STOCK',
    'AUTO_RETRIEVE',
    'INVENTORY_CHECK',
    'LOADING_ZONE_OPERATION',
    'CONVEYOR_MANUAL',
    'SENSOR_CHECK',
    'STRATEGY_CHANGE'
  ) NOT NULL,

  product_id INT NULL,
  cell_id INT NULL,

  cmd VARCHAR(100) NOT NULL,

  status ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'ERROR', 'CANCELLED') DEFAULT 'PENDING',
  error_message VARCHAR(255) NULL,
  execution_time_ms INT NULL,

  priority ENUM('LOW', 'MEDIUM', 'HIGH') DEFAULT 'MEDIUM',
  storage_strategy VARCHAR(50) NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,

  INDEX idx_status (status),
  INDEX idx_op_type (op_type),
  INDEX idx_priority (priority),
  INDEX idx_created (created_at),

  CONSTRAINT fk_ops_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT fk_ops_cell
    FOREIGN KEY (cell_id) REFERENCES cells(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;


-- =========================================================
-- OPERATION COMMAND CATALOG (all CAPITAL commands from UI)
-- This does NOT change values; it helps validation / documentation.
-- =========================================================
CREATE TABLE IF NOT EXISTS operation_commands (
  command VARCHAR(100) PRIMARY KEY,
  source VARCHAR(50) DEFAULT 'UI',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO operation_commands (command, source) VALUES
  ('HOME', 'HTML_DATALIST'),
  ('PICK', 'HTML_DATALIST'),
  ('GOTO 1', 'HTML_DATALIST'),
  ('GOTO 2', 'HTML_DATALIST'),
  ('GOTO 3', 'HTML_DATALIST'),
  ('GOTO 4', 'HTML_DATALIST'),
  ('PLACE 1 1', 'HTML_DATALIST'),
  ('TAKE 1 1', 'HTML_DATALIST'),
  ('LOADING_PLACE', 'HTML_DATALIST'),
  ('LOADING_TAKE', 'HTML_DATALIST'),
  ('LOADING_RETURN', 'HTML_DATALIST'),
  ('LOADING_OPEN', 'HTML_DATALIST'),
  ('LOADING_CLOSE', 'HTML_DATALIST'),
  ('CHECK_LOADING', 'HTML_DATALIST'),
  ('CONVEYOR_MOVE', 'HTML_DATALIST'),
  ('CONVEYOR_STOP', 'HTML_DATALIST'),
  ('STRATEGY NEAREST', 'HTML_DATALIST'),
  ('STRATEGY AI', 'HTML_DATALIST'),
  ('STRATEGY FIXED', 'HTML_DATALIST'),
  ('GET_IR_STATUS', 'HTML_DATALIST'),
  ('GET_LOADING_STATUS', 'HTML_DATALIST'),
  ('TEST_IR_SENSORS', 'HTML_DATALIST'),
  ('TEST_ULTRASONIC', 'HTML_DATALIST'),
  ('TEST_RFID', 'HTML_DATALIST'),
  ('TEST_LDR', 'HTML_DATALIST'),
  ('TEST_CONVEYOR', 'HTML_DATALIST');


-- =========================================================
-- AUTO TASK QUEUE (used by Node: /api/auto-tasks)
-- =========================================================
CREATE TABLE auto_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- IMPORTANT: Node.js (/api/enhanced-tasks) uses these extended task types.
  -- If you change them in server.js, update this ENUM too.
  task_type ENUM(
    'STOCK',
    'STOCK_FROM_CONVEYOR',
    'RETRIEVE',
    'RETRIEVE_TO_LOADING',
    'MOVE',
    'MOVE_TO_LOADING',
    'ORGANIZE',
    'REORGANIZE_WAREHOUSE',
    'LOAD_RETURN',
    'INVENTORY_CHECK'
  ) NOT NULL,

  cell_id INT NULL,
  product_id INT NULL,
  product_rfid VARCHAR(100) NULL,

  quantity INT DEFAULT 1,
  priority ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT') DEFAULT 'MEDIUM',
  storage_strategy ENUM('NEAREST_EMPTY', 'AI_OPTIMIZED', 'FIXED') DEFAULT 'NEAREST_EMPTY',

  status ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') DEFAULT 'PENDING',
  parameters JSON NULL,

  scheduled_at TIMESTAMP NULL,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,

  error_message VARCHAR(255) NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_task_status (status),
  INDEX idx_priority_scheduled (priority, scheduled_at),
  INDEX idx_strategy (storage_strategy),

  CONSTRAINT fk_tasks_cell
    FOREIGN KEY (cell_id) REFERENCES cells(id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT fk_tasks_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- SENSOR EVENTS (logging for IR/LDR/RFID/Ultrasonic/etc.)
-- =========================================================
CREATE TABLE sensor_events (
  id INT AUTO_INCREMENT PRIMARY KEY,

  source ENUM('IR_SENSOR', 'LDR1', 'LDR2', 'RFID', 'ULTRASONIC', 'LIMIT_SWITCH') NOT NULL,
  sensor_pin INT NULL,
  cell_id INT NULL,

  value VARCHAR(100) NOT NULL,
  unit VARCHAR(20) NULL,

  status ENUM('TRIGGERED', 'CLEARED', 'ERROR') DEFAULT 'TRIGGERED',

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_source_created (source, created_at),
  INDEX idx_cell (cell_id),
  INDEX idx_sensor (sensor_pin),

  CONSTRAINT fk_events_cell
    FOREIGN KEY (cell_id) REFERENCES cells(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- INVENTORY HISTORY (auditing / transparency)
-- =========================================================
CREATE TABLE inventory_history (
  id INT AUTO_INCREMENT PRIMARY KEY,

  cell_id INT NULL,
  product_id INT NULL,
  operation_type ENUM('STOCK_IN', 'STOCK_OUT', 'MOVE', 'ADJUST') NOT NULL,

  quantity_before INT NOT NULL,
  quantity_after INT NOT NULL,
  change_amount INT NOT NULL,

  operation_id INT NULL,
  notes TEXT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_cell_product (cell_id, product_id),
  INDEX idx_created (created_at),

  CONSTRAINT fk_hist_cell
    FOREIGN KEY (cell_id) REFERENCES cells(id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT fk_hist_product
    FOREIGN KEY (product_id) REFERENCES products(id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT fk_hist_operation
    FOREIGN KEY (operation_id) REFERENCES operations(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- IR SENSOR CALIBRATION (per cell pin)
-- =========================================================
CREATE TABLE sensor_calibration (
  id INT AUTO_INCREMENT PRIMARY KEY,

  sensor_pin INT NOT NULL UNIQUE,
  cell_id INT NOT NULL,

  trigger_threshold INT DEFAULT 500,
  calibration_value INT DEFAULT 0,
  last_calibrated TIMESTAMP NULL,

  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_calib_cell
    FOREIGN KEY (cell_id) REFERENCES cells(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================
-- SEED DATA
-- =========================================================

-- 1) Admin (replace hash with a real one if you implement auth)
INSERT INTO admins (username, password_hash)
VALUES ('admin', '$2y$10$exampleexampleexampleexampleexampleexampleex');

-- 2) Cells (3x4) with IR pins
INSERT INTO cells (row_num, col_num, label, ir_sensor_pin) VALUES
  (1,1,'R1C1',37),
  (1,2,'R1C2',38),
  (1,3,'R1C3',39),
  (1,4,'R1C4',40),
  (2,1,'R2C1',41),
  (2,2,'R2C2',42),
  (2,3,'R2C3',43),
  (2,4,'R2C4',44),
  (3,1,'R3C1',45),
  (3,2,'R3C2',46),
  (3,3,'R3C3',47),
  (3,4,'R3C4',48);

-- 3) Loading zone row
INSERT INTO loading_zone (id, product_id, quantity, ultrasonic_distance, servo_position, status)
VALUES (1, NULL, 0, NULL, 90, 'EMPTY');

-- 4) Conveyor status row
INSERT INTO conveyor_status (id, has_product, product_id, product_rfid, mode, state)
VALUES (1, FALSE, NULL, NULL, 'MANUAL', 'IDLE');

-- 5) System settings row
INSERT INTO system_settings (id, storage_strategy, auto_mode, conveyor_manual_control, loading_zone_auto_close, ir_sensor_auto_update)
VALUES (1, 'NEAREST_EMPTY', FALSE, FALSE, TRUE, TRUE);

-- 6) Sample products (safe)
INSERT INTO products (name, sku, rfid_uid, category, storage_strategy, fixed_row, fixed_col) VALUES
  ('Product A', 'PROD-A-001', '12.80.110.3', 'Electronics', 'NEAREST_EMPTY', NULL, NULL),
  ('Product B', 'PROD-B-001', '178.139.221.208', 'Tools', 'NEAREST_EMPTY', NULL, NULL),
  ('Product C', 'PROD-C-001', '204.187.101.3', 'Components', 'NEAREST_EMPTY', NULL, NULL),
  ('Product D', 'PROD-D-001', '12.86.101.3', 'Materials', 'AI_OPTIMIZED', NULL, NULL),
  ('Product E', 'PROD-E-001', '66.208.30.83', 'Electronics', 'FIXED', 1, 1),
  ('Product F', 'PROD-F-001', '252.53.92.3', 'Tools', 'NEAREST_EMPTY', NULL, NULL);

-- 7) Sensor calibration initial
INSERT INTO sensor_calibration (sensor_pin, cell_id, trigger_threshold, calibration_value) VALUES
  (37, 1, 500, 0), (38, 2, 500, 0), (39, 3, 500, 0), (40, 4, 500, 0),
  (41, 5, 500, 0), (42, 6, 500, 0), (43, 7, 500, 0), (44, 8, 500, 0),
  (45, 9, 500, 0), (46,10, 500, 0), (47,11, 500, 0), (48,12, 500, 0);

-- =========================================================
-- VIEWS (useful for dashboard / reporting)
-- =========================================================
CREATE OR REPLACE VIEW warehouse_current_status AS
SELECT
  c.id,
  c.label,
  c.row_num,
  c.col_num,
  c.ir_sensor_pin,
  c.status,
  c.sensor_status,
  c.last_sensor_check,
  c.product_id,
  p.name AS product_name,
  p.sku,
  p.rfid_uid,
  p.storage_strategy,
  c.quantity,
  c.updated_at
FROM cells c
LEFT JOIN products p ON c.product_id = p.id
ORDER BY c.row_num, c.col_num;

CREATE OR REPLACE VIEW auto_task_queue AS
SELECT
  t.*,
  c.label AS cell_label,
  p.name  AS product_name,
  p.rfid_uid,
  CASE
    WHEN t.status = 'PENDING' AND t.priority = 'URGENT' THEN 1
    WHEN t.status = 'PENDING' AND t.priority = 'HIGH'   THEN 2
    WHEN t.status = 'PENDING' AND t.priority = 'MEDIUM' THEN 3
    WHEN t.status = 'PENDING' AND t.priority = 'LOW'    THEN 4
    ELSE 5
  END AS execution_order
FROM auto_tasks t
LEFT JOIN cells c ON t.cell_id = c.id
LEFT JOIN products p ON t.product_id = p.id
WHERE t.status IN ('PENDING','PROCESSING')
ORDER BY execution_order, t.created_at;

CREATE OR REPLACE VIEW warehouse_stats AS
SELECT
  (SELECT COUNT(*) FROM cells) AS total_cells,
  (SELECT COUNT(*) FROM cells WHERE status = 'OCCUPIED') AS occupied_cells,
  (SELECT COUNT(*) FROM cells WHERE status = 'EMPTY') AS empty_cells,
  (SELECT COUNT(*) FROM cells WHERE sensor_status = 'ACTIVE') AS active_sensors,
  (SELECT COUNT(*) FROM products) AS total_products,
  (SELECT COUNT(*) FROM auto_tasks WHERE status = 'PENDING') AS pending_tasks,
  (SELECT status FROM loading_zone WHERE id = 1) AS loading_zone_status,
  (SELECT storage_strategy FROM system_settings WHERE id = 1) AS current_strategy,
  (SELECT mode FROM conveyor_status WHERE id = 1) AS conveyor_mode,
  NOW() AS timestamp;

-- Helpful indexes
CREATE INDEX idx_sensor_events_time ON sensor_events(created_at);
CREATE INDEX idx_inventory_cell_time ON inventory_history(cell_id, created_at);
CREATE INDEX idx_operations_time ON operations(created_at);
CREATE INDEX idx_cells_status_sensor ON cells(status, sensor_status);
CREATE INDEX idx_products_rfid_strategy ON products(rfid_uid, storage_strategy);

-- Comments
ALTER TABLE cells COMMENT = 'Warehouse cells (3x4) with IR sensor pins';
ALTER TABLE loading_zone COMMENT = 'Loading zone (ultrasonic + servo)';
ALTER TABLE system_settings COMMENT = 'Global system settings';
ALTER TABLE sensor_events COMMENT = 'Log of sensor events';
ALTER TABLE conveyor_status COMMENT = 'Conveyor belt status';
ALTER TABLE auto_tasks COMMENT = 'Auto mode queue';

SELECT '✅ smart_warehouse database initialized successfully' AS message;
ALTER TABLE conveyor_status
MODIFY state ENUM(
  'IDLE','MOVE_12CM','WAIT_RFID','MOVING_TO_LDR2','STOPPED','MANUAL_MODE','UNKNOWN'
) NOT NULL DEFAULT 'IDLE';

ALTER TABLE auto_tasks 
ADD COLUMN target_quantity INT DEFAULT 1 AFTER quantity,
ADD COLUMN task_group VARCHAR(50) NULL AFTER storage_strategy;

-- إضافة جدول للتنظيم الهرمي
CREATE TABLE IF NOT EXISTS reorganization_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_type ENUM('FILL_ROWS', 'CATEGORY_GROUPING', 'EMPTY_SPACE_CONSOLIDATION') DEFAULT 'FILL_ROWS',
  status ENUM('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED') DEFAULT 'PLANNED',
  parameters JSON NULL,
  total_tasks INT DEFAULT 0,
  completed_tasks INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL
) ENGINE=InnoDB;