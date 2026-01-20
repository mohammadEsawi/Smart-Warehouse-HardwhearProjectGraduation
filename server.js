// FILE: server.js - COMPLETE UPDATED VERSION
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import WebSocket, { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5001;

// ======== MIDDLEWARE ========
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ======== DATABASE CONFIG ========
const dbConfig = {
  host: "localhost",
  port: 3000,
  user: "root",
  password: "123456",
  database: "smart_warehouse",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// ======== ESP32 CONFIG ========
let ESP32_BASE_URL = null;
let isESP32Connected = false;

// ======== SYSTEM STATE ========
let currentSensorData = {
  ldr1: false,
  ldr2: false,
  rfid: null,
  conveyorState: "IDLE",
  armStatus: "READY",
  currentOperation: "",
  loadingZoneOccupied: false,
  storageStrategy: "NEAREST_EMPTY",
  cells: Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => false)),
  lastUpdate: null,
};

// ===== Loading Zone auto-return (إذا المنتج ظل فترة طويلة) =====
// ❌ Disabled per project requirement (no auto-return tasks)
// const LZ_AUTO_RETURN_MS = 120000; // 2 minutes
// let lzOccupiedSinceMs = null;

const armState = {
  status: "READY",
  mode: "manual",
  currentOperation: null,
  currentCell: null,
  currentProduct: null,
  storageStrategy: "NEAREST_EMPTY",
};

// ======== WEBSOCKET SERVER ========
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}
let lastWarehouseBroadcastMs = 0;
async function broadcastWarehouseDataThrottled(minGapMs = 500) {
  const now = Date.now();
  if (now - lastWarehouseBroadcastMs < minGapMs) return;
  lastWarehouseBroadcastMs = now;
  await broadcastWarehouseData();
}

// ======== HELPER FUNCTIONS ========
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

function normalizeStrategy(s) {
  const v = String(s || "").trim().toUpperCase();
  if (v === "NEAREST" || v === "NEAREST_EMPTY") return "NEAREST_EMPTY";
  if (v === "FIXED") return "FIXED";
  if (v === "AI" || v === "AI_OPTIMIZED") return "AI_OPTIMIZED";
  return null;
}
const irFalseCount = Array.from({ length: 3 }, () => Array(4).fill(0));

function to2DCells(cellsPayload) {
  const grid = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => false));
  if (!cellsPayload) return grid;

  if (Array.isArray(cellsPayload) && cellsPayload.length === 3 && Array.isArray(cellsPayload[0])) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        grid[r][c] = !!(cellsPayload[r] && cellsPayload[r][c]);
      }
    }
    return grid;
  }

  if (Array.isArray(cellsPayload) && cellsPayload.length && typeof cellsPayload[0] === "object") {
    for (const it of cellsPayload) {
      const r = Number(it.row);
      const c = Number(it.col);
      if (r >= 1 && r <= 3 && c >= 1 && c <= 4) {
        grid[r - 1][c - 1] = !!it.occupied;
      }
    }
    return grid;
  }

  return grid;
}

function applyLiveCellStatus(rows) {
  try {
    const grid = Array.isArray(currentSensorData?.cells) ? currentSensorData.cells : null;
    if (!grid) return rows;

    return rows.map((c) => {
      const r = Number(c.row_num) - 1;
      const col = Number(c.col_num) - 1;
      const sensorOcc = !!(grid[r] && typeof grid[r][col] !== "undefined" ? grid[r][col] : false);

      // ✅ Debounce counts (نستخدم نفس irFalseCount الموجود عندك)
      const falseCnt = irFalseCount?.[r]?.[col] ?? 0;

      // إذا السنسور فاضي بشكل ثابت (مثلاً 2 تحديثات) → اعرضها EMPTY وامسح العرض فقط
      const sensorStableEmpty = (!sensorOcc && falseCnt >= 2);

      if (sensorStableEmpty) {
        return {
          ...c,
          sensor_occupied: false,
          display_status: "EMPTY",
          // ✅ امسح المعروض (مش DB) حتى ما يضل يبين اسم قديم
          product_name: null,
          rfid_uid: null,
          quantity: 0,
        };
      }

      let display = c.status;
      if (c.status === "EMPTY" && sensorOcc) display = "OCCUPIED";

      return {
        ...c,
        sensor_occupied: sensorOcc,
        display_status: display,
      };
    });
  } catch {
    return rows;
  }
}



// ======== WEBSOCKET HANDLERS ========
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("WebSocket client connected");

  ws.send(JSON.stringify({
    type: "init",
    armState,
    sensorData: currentSensorData,
    esp32Connected: isESP32Connected,
    timestamp: new Date().toISOString(),
  }));

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      handleClientMessage(ws, message);
    } catch (error) {
      console.error("Error parsing client message:", error);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("WebSocket client disconnected");
  });
});

// ======== STORAGE STRATEGY HELPER ========
async function setStorageStrategy(strategy) {
  try {
    const normalized = normalizeStrategy(strategy);
    const validStrategies = ["NEAREST_EMPTY", "AI_OPTIMIZED", "FIXED"];
    
    if (!validStrategies.includes(normalized)) {
      console.error(`Invalid strategy: ${strategy}`);
      return;
    }

    await pool.query("UPDATE system_settings SET storage_strategy = ? WHERE id = 1", [normalized]);

    armState.storageStrategy = normalized;
    currentSensorData.storageStrategy = normalized;

    if (ESP32_BASE_URL && isESP32Connected) {
      try {
        const strategyCmd = normalized === "AI_OPTIMIZED" ? "AI" :
                          normalized === "FIXED" ? "FIXED" : "NEAREST";
        const command = `STRATEGY ${strategyCmd}`;
        await sendCommandToESP32(command);
      } catch (err) {
        console.error("Failed to send strategy to ESP32:", err);
      }
    }

    broadcast({
      type: "strategy_update",
      strategy: normalized,
      timestamp: new Date().toISOString(),
    });

    console.log(`Storage strategy set to: ${normalized}`);
  } catch (err) {
    console.error("Error setting storage strategy:", err);
  }
}

function handleClientMessage(ws, message) {
  switch (message.type) {
    case "request_sensor_data":
      ws.send(JSON.stringify({ type: "sensor_update", data: currentSensorData }));
      break;
    case "refresh_data":
      broadcastWarehouseData();
      break;
    case "set_strategy":
      setStorageStrategy(message.strategy);
      break;
    default:
      console.log("Unknown client message:", message);
  }
}
// ======== DATABASE INITIALIZATION ========
async function initializeDatabase() {
  try {
    console.log("Initializing database...");

    // Ensure needed tables exist (lightweight init)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_locations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        rfid_uid VARCHAR(100) NOT NULL,
        cell_id INT NULL,
        loading_zone_id INT NULL,
        status ENUM('IN_CELL', 'IN_LOADING_ZONE', 'ON_CONVEYOR') NOT NULL,
        quantity INT DEFAULT 1,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_rfid (rfid_uid),
        INDEX idx_product (product_id),
        INDEX idx_status (status),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (cell_id) REFERENCES cells(id) ON DELETE SET NULL
      )
    `);

    // 🔥 Fix "Data truncated" issues if old schema used ENUMs for these columns
    try { await pool.query("ALTER TABLE auto_tasks MODIFY COLUMN task_type VARCHAR(50) NOT NULL"); } catch (e) {}
    try { await pool.query("ALTER TABLE operations MODIFY COLUMN op_type VARCHAR(50) NOT NULL"); } catch (e) {}

    // ✅ Ensure cells can cache RFID + product name for UI
    try { await pool.query('ALTER TABLE cells ADD COLUMN rfid_uid_cache VARCHAR(100) NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE cells ADD COLUMN product_name_cache VARCHAR(100) NULL'); } catch (e) {}

    // ✅ Ensure loading zone can cache RFID + product name for UI
    try { await pool.query('ALTER TABLE loading_zone ADD COLUMN rfid_uid_cache VARCHAR(100) NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE loading_zone ADD COLUMN product_name_cache VARCHAR(100) NULL'); } catch (e) {}

    console.log("✅ Database initialized successfully");
  } catch (err) {
    console.error("Error initializing DB:", err);
  }
}

// أضف هذه الدالة بعد initializeDatabase مباشرة
async function checkAutoModeOnStart() {
  try {
    const [settings] = await pool.query(
      "SELECT auto_mode FROM system_settings WHERE id = 1"
    );
    
    const autoMode = settings[0]?.auto_mode || false;
    
    if (autoMode) {
      console.log("Auto mode was ON from previous session. Starting processor...");
      startAutoTaskProcessor();
    }
  } catch (error) {
    console.error("Error checking auto mode on start:", error);
  }
}

// ======== COMPLETE ENHANCED TASK HANDLERS ========

async function processEnhancedAutoTask(task) {
  try {
    console.log(`Processing enhanced task: ${task.task_type} (ID: ${task.id})`);

    // Track execution window to prevent "false COMPLETED" when no real sensor updates arrive.
    // If the ESP32/Mega isn't sending fresh /api/sensors/update events, the armStatus may stay READY
    // and tasks would appear completed instantly. We will fail such tasks instead.
    const execStartMs = Date.now();
    const opBeforeExec = String(currentSensorData?.currentOperation || "");
    const lastUpdateBeforeExec = currentSensorData?.lastUpdate
      ? new Date(currentSensorData.lastUpdate).getTime()
      : 0;
    
    // Claim task: only move PENDING -> PROCESSING (prevents double-processing)
    const [claimRes] = await pool.query(
      'UPDATE auto_tasks SET status = "PROCESSING", started_at = NOW() WHERE id = ? AND status = "PENDING"',
      [task.id]
    );

    if (!claimRes.affectedRows) {
      console.log(`Task ${task.id} was already taken (status not PENDING). Skipping.`);
      return;
    }

    broadcast({ type: "task_update", task: { ...task, status: "PROCESSING" } });

    switch (task.task_type) {
      case 'STOCK':
      case 'STOCK_FROM_CONVEYOR':
        await handleStockFromConveyor(task);
        break;
      case 'RETRIEVE':
      case 'RETRIEVE_TO_LOADING':
        await handleRetrieveToLoading(task);
        break;
      case 'MOVE':
      case 'MOVE_TO_LOADING':
        await handleMoveToLoading(task);
        break;
      // ❌ Disabled per final requirement
      case 'ORGANIZE':
      case 'REORGANIZE_WAREHOUSE':
      case 'LOAD_RETURN':
        // Remove these tasks immediately so Auto Mode doesn't get stuck
        await pool.query('DELETE FROM auto_tasks WHERE id = ?', [task.id]);
        broadcast({ type: "task_update", task: { ...task, status: "CANCELLED", error_message: "Task type disabled" } });
        return;
      case 'INVENTORY_CHECK':
        await handleInventoryCheck(task);
        break;
      default:
        console.log(`Unknown task type: ${task.task_type}`);
        throw new Error(`Unknown task type: ${task.task_type}`);
    }

    // Barrier: never mark task completed until arm is READY again
    try {
      await waitForArmReady(120000);
    } catch (e) {
      // If READY never arrives, fail the task (will be handled below)
      throw new Error(`Arm not READY after task: ${e.message}`);
    }

    // ✅ Single completion point (handlers must NOT call completeTask)
    await broadcastWarehouseData();

    // Extra safety: for motion-related tasks, require at least one fresh sensor update OR op change.
    const ttype = String(task.task_type || "").toUpperCase();
    const motionTasks = new Set([
      "STOCK",
      "STOCK_FROM_CONVEYOR",
      "RETRIEVE",
      "RETRIEVE_TO_LOADING",
      "MOVE",
      "MOVE_TO_LOADING",
      "ORGANIZE",
      "REORGANIZE_WAREHOUSE",
      "LOAD_RETURN",
    ]);

    if (motionTasks.has(ttype)) {
      const lu = currentSensorData?.lastUpdate ? new Date(currentSensorData.lastUpdate).getTime() : 0;
      const opNow = String(currentSensorData?.currentOperation || "");
      const hasFreshUpdate = lu >= execStartMs || lu > lastUpdateBeforeExec;
      const opChanged = opNow && opNow !== opBeforeExec;

      if (!hasFreshUpdate && !opChanged) {
        throw new Error(
          "No fresh sensor updates were received during this task (arm didn't actually execute). Check ESP32/Mega status and /api/sensors/update."
        );
      }
    }

    // ✅ Mark task as completed + remove from queue (as project requirement)
    await completeTask(task.id);

  } catch (error) {
    console.error(`Error processing task ${task.id}:`, error);
    await pool.query(
      'UPDATE auto_tasks SET status = "FAILED", error_message = ? WHERE id = ?',
      [error.message, task.id]
    );
    broadcast({ type: "task_update", task: { ...task, status: "FAILED", error_message: error.message } });
  }
}

async function handleStockFromConveyor(task) {
  // IMPORTANT:
  // Stock-from-conveyor يجب أن يكون "sensor-driven":
  // - لا يبدأ الكونفيري إلا إذا LDR1 فعّال
  // - يتحرك 12cm ثم يقرأ RFID
  // - يكمل لحد LDR2 ثم يعمل PICK + PLACE
  // هذا كله يحصل على الميجا داخل الـ state machine عنده.
  const qty = Math.max(1, parseInt(task.target_quantity || task.quantity || 1, 10) || 1);

  if (!ESP32_BASE_URL || !isESP32Connected) {
    throw new Error("ESP32 not connected");
  }

  // فعّل مخزون الكونفيري على الميجا (هو سيقرأ RFID بنفسه)
  await pool.query(
    'UPDATE auto_tasks SET parameters = JSON_SET(COALESCE(parameters, "{}"), "$.processed", ?, "$.total", ?) WHERE id = ?',
    [0, qty, task.id]
  );

  const opBefore = String(currentSensorData?.currentOperation || "");
  const startMs = Date.now();
  await sendCommandToESP32(`STOCK_QTY:${qty}`);

  // انتظر انتهاء الكمية (fresh)
  // (الـ ESP32 سيقوم بإرسال STOCK_QTY_DONE عند الانتهاء)
  const perItemTimeout = 120000;
  await waitForSensorOpEvent("STOCK_QTY_DONE", opBefore, startMs, Math.max(90000, qty * perItemTimeout));

  // أمان: اضمن إيقاف الكمية
  try { await sendCommandToESP32("STOCK_QTY:0"); } catch (_) {}
}

// أضف دالة انتظار فراغ الكونفيور
async function waitForConveyorEmpty(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ldr1 = currentSensorData?.ldr1 || false;
    const ldr2 = currentSensorData?.ldr2 || false;
    
    if (!ldr1 && !ldr2) {
      return true;
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Conveyor still has product after timeout");
}

async function handleRetrieveToLoading(task) {
  const { cell_id, product_id } = task;

  let targetCell = null;

  if (cell_id) {
    const [cells] = await pool.query(
      `SELECT c.*, p.rfid_uid
       , p.name AS product_name
       FROM cells c
       LEFT JOIN products p ON c.product_id = p.id
       WHERE c.id = ?`,
      [cell_id]
    );
    targetCell = cells[0] || null;
  } else if (product_id) {
    const [cells] = await pool.query(
      `SELECT c.*, p.rfid_uid
       , p.name AS product_name
       FROM cells c
       LEFT JOIN products p ON c.product_id = p.id
       WHERE c.product_id = ? AND c.status = 'OCCUPIED'
       ORDER BY c.row_num, c.col_num
       LIMIT 1`,
      [product_id]
    );
    targetCell = cells[0] || null;
  }

  if (!targetCell || !targetCell.product_id) {
    throw new Error("No occupied source cell found for retrieval");
  }

  if (!ESP32_BASE_URL || !isESP32Connected) {
    throw new Error("ESP32 not connected");
  }

  // 1. الذهاب للخلية وأخذ المنتج
  await sendCmdAndWaitOp(`TAKE ${targetCell.col_num} ${targetCell.row_num}`, "PICK_FROM_CELL_DONE", 60000);
  
  // 2. العودة للهوم
  await sendCommandToESP32("HOME");
  await waitForArmReady(30000);
  
  // 3. الانتقال للودنج زون
  await sendCmdAndWaitOp(`MOVE_TO_LOADING:${targetCell.col_num} ${targetCell.row_num}`, "MOVE_TO_LOADING_COMPLETE", 60000);
  
  // 4. العودة للهوم مجدداً
  await sendCommandToESP32("HOME");
  await waitForArmReady(30000);

  // تحديث قاعدة البيانات
  await pool.query(
    'UPDATE cells SET status="EMPTY", product_id=NULL, rfid_uid_cache=NULL, product_name_cache=NULL, quantity=0, updated_at=NOW() WHERE id = ?',
    [targetCell.id]
  );

  await pool.query(
    'UPDATE loading_zone SET status="OCCUPIED", product_id=?, quantity=1, rfid_uid_cache=COALESCE(?, rfid_uid_cache), product_name_cache=COALESCE(?, product_name_cache), updated_at=NOW() WHERE id = 1',
    [targetCell.product_id, (targetCell.rfid_uid || null), (targetCell.product_name_cache || null)]
  );

  // track location
  if (targetCell.rfid_uid) {
    try { await updateProductLocation(targetCell.rfid_uid, 'IN_LOADING_ZONE', null, 1); } catch (_) {}
  }
  broadcastWarehouseData();
}

async function handleMoveToLoading(task) {
  // Kept for backward compatibility: MOVE_TO_LOADING task requires cell_id
  const { cell_id } = task;

  if (!cell_id) throw new Error("Cell ID is required for move to loading");

  const [cells] = await pool.query(
    `SELECT c.*, p.rfid_uid, p.name AS product_name
     FROM cells c
     LEFT JOIN products p ON c.product_id = p.id
     WHERE c.id = ?`,
    [cell_id]
  );

  const cell = cells[0];
  if (!cell || !cell.product_id) throw new Error("Cell is empty");

  if (!ESP32_BASE_URL || !isESP32Connected) {
    throw new Error("ESP32 not connected");
  }

  await sendCmdAndWaitOp(`MOVE_TO_LOADING:${cell.col_num} ${cell.row_num}`, "MOVE_TO_LOADING_COMPLETE", 120000);

  await pool.query(
    'UPDATE cells SET status="EMPTY", product_id=NULL, rfid_uid_cache=NULL, product_name_cache=NULL, quantity=0, updated_at=NOW() WHERE id = ?',
    [cell.id]
  );

  await pool.query(
    'UPDATE loading_zone SET status="OCCUPIED", product_id=?, quantity=1, rfid_uid_cache=COALESCE(?, rfid_uid_cache), product_name_cache=COALESCE(?, product_name_cache), updated_at=NOW() WHERE id = 1',
    [cell.product_id, (cell.rfid_uid || null), (cell.product_name || null)]
  );
  if (cell.rfid_uid) {
    try { await updateProductLocation(cell.rfid_uid, 'IN_LOADING_ZONE', null, 1); } catch (_) {}
  }
  broadcastWarehouseData();
}

async function handleReorganizeWarehouse(task) {
  if (!ESP32_BASE_URL || !isESP32Connected) {
    throw new Error("ESP32 not connected");
  }

  // parameters: { order: 'ROW_MAJOR' | 'COLUMN_MAJOR' }
  let orderMode = 'ROW_MAJOR';
  try {
    if (task?.parameters) {
      const params = typeof task.parameters === 'string' ? JSON.parse(task.parameters) : task.parameters;
      const o = String(params?.order || params?.mode || '').toUpperCase();
      if (o.includes('COL')) orderMode = 'COLUMN_MAJOR';
      if (o.includes('ROW')) orderMode = 'ROW_MAJOR';
    }
  } catch (_) {}

  const [allCellsRaw] = await pool.query(
    `SELECT c.id, c.row_num, c.col_num, c.status, c.product_id,
            c.rfid_uid_cache, c.product_name_cache,
            p.rfid_uid AS rfid_uid_real,
            p.name AS product_name_real
     FROM cells c
     LEFT JOIN products p ON c.product_id = p.id
     WHERE c.status IN ('EMPTY','OCCUPIED')
     ORDER BY c.row_num, c.col_num`
  );

  // Decide scanning order: row-major or column-major
  const allCells = [...allCellsRaw].sort((a, b) => {
    if (orderMode === 'COLUMN_MAJOR') {
      if (a.col_num !== b.col_num) return a.col_num - b.col_num;
      return a.row_num - b.row_num;
    }
    if (a.row_num !== b.row_num) return a.row_num - b.row_num;
    return a.col_num - b.col_num;
  });

  // Take the occupied cells in the same scan order, then compact into the first N slots in that order
  const occupied = allCells
    .filter((c) => c.status === "OCCUPIED" && c.product_id)
    .map((c) => ({
      ...c,
      rfid_uid_cache: c.rfid_uid_cache || c.rfid_uid_real || null,
      product_name_cache: c.product_name_cache || c.product_name_real || null,
    }));

  if (occupied.length === 0) {
    console.log("REORGANIZE: warehouse empty -> nothing to do");
    return;
  }

  // First N cells in the chosen scan order should be occupied after reorganize
  const desiredSlots = allCells.slice(0, occupied.length);

  // إذا المخزن كامل وفيه تغييرات لازمة: نحتاج خلية فاضية كـ buffer
  const emptyBuffers = allCells.filter((c) => c.status === "EMPTY");
  const needAnyMove = desiredSlots.some((slot, i) => slot.id !== occupied[i].id);
  if (needAnyMove && emptyBuffers.length === 0) {
    throw new Error("REORGANIZE يحتاج خلية EMPTY واحدة على الأقل (warehouse full)");
  }

  // حالة محلية قابلة للتحديث أثناء النقل
  const state = new Map(); // cellId -> {product_id, rfid_uid_cache, product_name_cache} | null
  for (const c of allCells) {
    if (c.status === "OCCUPIED" && c.product_id) {
      state.set(c.id, {
        product_id: c.product_id,
        rfid_uid_cache: c.rfid_uid_cache || c.rfid_uid_real || null,
        product_name_cache: c.product_name_cache || c.product_name_real || null,
      });
    } else {
      state.set(c.id, null);
    }
  }

  const byId = new Map(allCells.map((c) => [c.id, c]));
  const pickPlace = async (srcId, dstId) => {
    const src = byId.get(srcId);
    const dst = byId.get(dstId);
    if (!src || !dst) throw new Error("Invalid cell id in reorganize");
    await sendCmdAndWaitOp(`TAKE ${src.col_num} ${src.row_num}`, "PICK_FROM_CELL_DONE", 120000);
    await sendCmdAndWaitOp(`PLACE ${dst.col_num} ${dst.row_num}`, "PLACE_COMPLETE", 120000);
  };

  // خلية buffer واحدة (أول EMPTY)
  const bufferCell = emptyBuffers[0] || null;

  // helper to write DB for a single cell from state
  const persistCell = async (cellId) => {
    const content = state.get(cellId);
    if (!content) {
      await pool.query(
        "UPDATE cells SET status='EMPTY', product_id=NULL, rfid_uid_cache=NULL, product_name_cache=NULL, quantity=0, updated_at=NOW() WHERE id=?",
        [cellId]
      );
    } else {
      await pool.query(
        "UPDATE cells SET status='OCCUPIED', product_id=?, rfid_uid_cache=?, product_name_cache=?, quantity=GREATEST(quantity,1), updated_at=NOW() WHERE id=?",
        [content.product_id, content.rfid_uid_cache, content.product_name_cache, cellId]
      );
    }
  };

  // نفّذ إعادة التنظيم
  for (let i = 0; i < desiredSlots.length; i++) {
    const target = desiredSlots[i];
    const wantedContent = {
      product_id: occupied[i].product_id,
      rfid_uid_cache: occupied[i].rfid_uid_cache || null,
      product_name_cache: occupied[i].product_name_cache || null,
    };

    const targetContent = state.get(target.id);
    if (targetContent && targetContent.product_id === wantedContent.product_id) {
      continue; // already correct
    }

    // ابحث عن الخلية الحالية التي تحمل هذا المنتج
    let sourceId = null;
    for (const [cid, content] of state.entries()) {
      if (content && content.product_id === wantedContent.product_id) {
        sourceId = cid;
        break;
      }
    }
    if (!sourceId) {
      console.warn("REORGANIZE: product not found in state (skipping)");
      continue;
    }

    if (sourceId === target.id) {
      continue;
    }

    // إذا الهدف مش فاضي، لازم نفرغه للـ buffer
    if (state.get(target.id) && bufferCell) {
      // move target -> buffer
      await pickPlace(target.id, bufferCell.id);
      state.set(bufferCell.id, state.get(target.id));
      state.set(target.id, null);
      await persistCell(bufferCell.id);
      await persistCell(target.id);
    }

    // move source -> target
    await pickPlace(sourceId, target.id);
    state.set(target.id, state.get(sourceId));
    state.set(sourceId, null);
    await persistCell(target.id);
    await persistCell(sourceId);

    // تحديث product_locations (إذا عندنا RFID cache)
    const placed = state.get(target.id);
    if (placed?.rfid_uid_cache) {
      try { await updateProductLocation(placed.rfid_uid_cache, "REORGANIZED", target.id); } catch (_) {}
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  // رجّع للهوم بالنهاية (مفيد للاستقرار)
  try {
    await sendCommandToESP32("HOME");
    await waitForArmReady(60000);
  } catch (_) {}

  await sendCommandToESP32("REORGANIZE_WAREHOUSE_COMPLETE");
  broadcastWarehouseData();
}
// احتفظ بالدالة الأصلية للتوافق
async function handleLoadReturn(task) {
  if (!ESP32_BASE_URL || !isESP32Connected) {
    throw new Error("ESP32 not connected");
  }

  await sendCmdAndWaitOp("LOAD_RETURN", "LOAD_RETURN_COMPLETE", 120000);

  // After return, loading zone becomes empty (Mega reports it too, but we keep DB consistent)
  await pool.query(
    'UPDATE loading_zone SET status="EMPTY", product_id=NULL, quantity=0, updated_at=NOW() WHERE id = 1'
  );
  broadcastWarehouseData();
}

// واحتفظ بالدالة المحسنة
async function handleLoadReturnEnhanced(task) {
  if (!ESP32_BASE_URL || !isESP32Connected) {
    throw new Error("ESP32 not connected");
  }

  const { parameters } = task;
  let targetCell = null;

  // إذا كان هناك خلية مستهدفة محددة
  if (parameters) {
    try {
      const params = JSON.parse(parameters);
      if (params.return_to_cell_id) {
        const [cells] = await pool.query(
          `SELECT * FROM cells WHERE id = ?`,
          [params.return_to_cell_id]
        );
        targetCell = cells[0];
      }
    } catch (e) {
      console.error("Error parsing parameters:", e);
    }
  }

  // إذا ما في خلية محددة، ابحث عن أقرب خلية فارغة
  if (!targetCell) {
    const [emptyCells] = await pool.query(
      `SELECT * FROM cells WHERE status = 'EMPTY' 
       ORDER BY row_num, col_num LIMIT 1`
    );
    
    if (emptyCells.length === 0) {
      throw new Error("No empty cells available for return");
    }
    
    targetCell = emptyCells[0];
  }

  console.log(`Returning product to R${targetCell.row_num}C${targetCell.col_num}`);

  // 1. أرسل أمر الإرجاع للميجا
  await sendCmdAndWaitOp(`LOAD_RETURN_TO:${targetCell.col_num} ${targetCell.row_num}`, "LOAD_RETURN_COMPLETE", 90000);

  // 2. احفظ المنتج الموجود في الـ Loading Zone قبل ما تفضّيه
  const [loadingProduct] = await pool.query(
    `SELECT product_id FROM loading_zone WHERE id = 1`
  );

  // 3. حدّث قاعدة البيانات: Loading Zone -> EMPTY
  await pool.query(
    `UPDATE loading_zone SET status = 'EMPTY', product_id = NULL, quantity = 0 
     WHERE id = 1`
  );

  // 4. إذا كان في منتج، ضعه في الخلية الجديدة
  if (loadingProduct[0]?.product_id) {
    // Get product info for caching
    let rfidCache = null;
    let nameCache = null;
    try {
      const [pr] = await pool.query('SELECT rfid_uid, name FROM products WHERE id = ? LIMIT 1', [loadingProduct[0].product_id]);
      if (pr.length) {
        rfidCache = pr[0].rfid_uid || null;
        nameCache = pr[0].name || null;
      }
    } catch (e) {}

    await pool.query(
      `UPDATE cells SET status = 'OCCUPIED', product_id = ?, rfid_uid_cache=?, product_name_cache=?, quantity = 1 
       WHERE id = ?`,
      [loadingProduct[0].product_id, rfidCache, nameCache, targetCell.id]
    );
  }
}


async function handleInventoryCheck(task) {
  // Get current inventory status
  const [cells] = await pool.query(`
    SELECT c.*, p.name as product_name, p.rfid_uid
    FROM cells c
    LEFT JOIN products p ON c.product_id = p.id
    ORDER BY c.row_num, c.col_num
  `);
  
  const [loadingZone] = await pool.query('SELECT * FROM loading_zone WHERE id = 1');
  const [conveyor] = await pool.query('SELECT * FROM conveyor_status WHERE id = 1');
  
  // Create inventory report
  const report = {
    timestamp: new Date().toISOString(),
    cells: cells.map(cell => ({
      cell_id: cell.id,
      label: cell.label,
      row: cell.row_num,
      col: cell.col_num,
      status: cell.status,
      product_id: cell.product_id,
      product_name: cell.product_name,
      rfid_uid: cell.rfid_uid,
      quantity: cell.quantity
    })),
    loading_zone: loadingZone[0],
    conveyor: conveyor[0],
    summary: {
      total_cells: cells.length,
      occupied_cells: cells.filter(c => c.status === 'OCCUPIED').length,
      empty_cells: cells.filter(c => c.status === 'EMPTY').length,
      loading_zone_status: loadingZone[0]?.status || 'EMPTY',
      conveyor_has_product: conveyor[0]?.has_product || false
    }
  };
  
  // Log inventory check
  await pool.query(
    `INSERT INTO operations (op_type, cmd, status, priority)
     VALUES ('INVENTORY_CHECK', 'Inventory check completed', 'COMPLETED', 'LOW')`
  );
  
  // Broadcast inventory report
  broadcast({ type: "inventory_report", report });
}

// Utility function to wait for conveyor
async function waitForConveyorReady() {
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      const [conveyor] = await pool.query(
        'SELECT has_product FROM conveyor_status WHERE id = 1'
      );
      
      if (!conveyor[0]?.has_product) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 1000);
  });
}

async function waitForSensorOpContains(substr, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const op = String(currentSensorData?.currentOperation || "");
    if (op.includes(substr)) return op;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for operation: ${substr}`);
}

// Fresh wait: prevents false-positive when previous task left the DONE marker in currentOperation.
// Waits until currentOperation changes (op != prevOp) AND includes substr AND comes after startMs.
async function waitForSensorOpEvent(substr, prevOp, startMs, timeoutMs = 60000) {
  const start = Date.now();
  const prev = String(prevOp || "");
  const minTs = typeof startMs === "number" ? startMs : 0;

  while (Date.now() - start < timeoutMs) {
    const op = String(currentSensorData?.currentOperation || "");
    const lu = currentSensorData?.lastUpdate ? new Date(currentSensorData.lastUpdate).getTime() : 0;

    if (op && op !== prev && op.includes(substr) && (minTs == 0 || lu >= (minTs - 50))) {
      return op;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Timeout waiting for NEW operation: ${substr}`);
}

async function waitForArmReady(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = String(currentSensorData?.armStatus || "").toUpperCase();
    if (st.includes("READY") || st.includes("IDLE")) return st;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Timeout waiting for arm READY");
}

async function waitForRFIDOnConveyor(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tag = String(currentSensorData?.rfid || "").trim();
    if (tag && tag !== "0" && tag !== "null") return tag;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Timeout waiting for RFID on conveyor");
}

// Utility function to complete task
async function completeTask(taskId) {
  await pool.query(
    'UPDATE auto_tasks SET status = "COMPLETED", completed_at = NOW() WHERE id = ?',
    [taskId]
  );

  const [taskRows] = await pool.query('SELECT * FROM auto_tasks WHERE id = ?', [taskId]);
  const task = taskRows[0];

  if (task) {
    broadcast({ type: "task_update", task: { ...task, status: "COMPLETED" } });
    // User requirement: remove completed tasks from queue
    await pool.query('DELETE FROM auto_tasks WHERE id = ?', [taskId]);
  }
}

// Update product location tracking
async function updateProductLocation(rfid_uid, action, cell_id = null, loading_zone_id = 1) {
  const [products] = await pool.query(
    'SELECT id FROM products WHERE rfid_uid = ?',
    [rfid_uid]
  );
  
  if (products.length === 0) return;
  
  const product_id = products[0].id;
  
  switch (action) {
    case 'STOCKED':
      await pool.query(`
        INSERT INTO product_locations (product_id, rfid_uid, cell_id, status, quantity)
        VALUES (?, ?, ?, 'IN_CELL', 1)
        ON DUPLICATE KEY UPDATE
        cell_id = VALUES(cell_id),
        status = VALUES(status),
        last_updated = NOW()
      `, [product_id, rfid_uid, cell_id]);
      break;
      
    case 'IN_LOADING_ZONE':
      await pool.query(`
        INSERT INTO product_locations (product_id, rfid_uid, loading_zone_id, status, quantity)
        VALUES (?, ?, ?, 'IN_LOADING_ZONE', 1)
        ON DUPLICATE KEY UPDATE
        loading_zone_id = VALUES(loading_zone_id),
        status = VALUES(status),
        last_updated = NOW()
      `, [product_id, rfid_uid, loading_zone_id]);
      break;
  }
}


async function sendCommandToESP32(command) {
  if (!ESP32_BASE_URL) {
    throw new Error("ESP32 not registered");
  }

  const url = `${ESP32_BASE_URL}/cmd?c=${encodeURIComponent(command)}`;
  console.log(`[Node → ESP32] ${command}`);

  try {
    const resp = await fetchWithTimeout(url, {}, 10000);
    const text = await resp.text();

    if (!resp.ok) {
      throw new Error(`ESP32 HTTP ${resp.status}: ${text}`);
    }

    return { success: true, message: text };
  } catch (err) {
    console.error("Error sending command to ESP32:", err.message);
    throw err;
  }
}

// Send a command and wait for a *fresh* DONE marker in currentOperation.
// This avoids the bug where the next task instantly completes because currentOperation still contains the previous DONE.
async function sendCmdAndWaitOp(command, doneMarker, timeoutMs = 60000) {
  const prevOp = String(currentSensorData?.currentOperation || "");
  const startMs = Date.now();
  await sendCommandToESP32(command);
  return await waitForSensorOpEvent(doneMarker, prevOp, startMs, timeoutMs);
}


app.get("/api/cells", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        c.*,
        p.name AS product_name,
        p.sku,
        p.rfid_uid,
        c.status AS display_status,
        CASE
          WHEN c.ir_sensor_pin IS NOT NULL THEN 'ACTIVE'
          ELSE 'INACTIVE'
        END AS sensor_status
      FROM cells c
      LEFT JOIN products p ON c.product_id = p.id
      ORDER BY c.row_num, c.col_num
    `);

    res.json(applyLiveCellStatus(rows));
  } catch (err) {
    console.error("Error /api/cells:", err);
    res.status(500).json({ error: "Database error" });
  }
});


// Products API
app.get("/api/products", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, name, sku, rfid_uid, category, auto_assign, storage_strategy, created_at, updated_at
      FROM products
      ORDER BY id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error GET /api/products:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Operations API
// ======== OPERATIONS POST API ========
app.post("/api/operations", async (req, res) => {
  const connection = await pool.getConnection();
  const startTime = Date.now();
  let operationId = null;

  const isDirectCommand = (command) => {
      return command.startsWith("GET_") || 
             command.startsWith("TEST_") ||
             command === "CHECK_LOADING";
    };

  try {
    let { op_type, cmd, product_id, cell_id, priority = "MEDIUM" } = req.body;

    cmd = String(cmd || "").trim();
    if (!cmd) return res.status(400).json({ success: false, error: "cmd is required" });

    if (!op_type) {
      if (cmd.startsWith("CONVEYOR_")) op_type = "CONVEYOR_MANUAL";
      else if (cmd.startsWith("LOADING_") || cmd === "CHECK_LOADING") op_type = "LOADING_ZONE_OPERATION";
      else if (cmd.startsWith("STRATEGY")) op_type = "STRATEGY_CHANGE";
      else if (cmd.startsWith("TEST_")) op_type = "SENSOR_CHECK";
      else op_type = "MANUAL_CMD";
    }

      if (!ESP32_BASE_URL || !isESP32Connected) {
      if (!isDirectCommand(cmd)) {
        await connection.query(
          `INSERT INTO operations (op_type, cmd, product_id, cell_id, status, priority, completed_at, error_message, execution_time_ms)
           VALUES (?, ?, ?, ?, 'ERROR', ?, NOW(), 'ESP32 not connected', 0)`,
          [op_type, cmd, product_id || null, cell_id || null, priority]
        );
        return res.status(400).json({ success: false, error: "ESP32 not connected" });
      }
    }
   

    // For direct commands, complete immediately
    if (isDirectCommand(cmd)) {
      const [result] = await connection.query(
        `INSERT INTO operations (op_type, cmd, product_id, cell_id, status, priority, started_at, completed_at, execution_time_ms)
         VALUES (?, ?, ?, ?, 'COMPLETED', ?, NOW(), NOW(), 0)`,
        [op_type, cmd, product_id || null, cell_id || null, priority]
      );
      
      operationId = result.insertId;
      broadcast({ type: "operation_update", operation: { id: operationId, status: "COMPLETED", op_type, cmd } });
      
      return res.json({ 
        success: true, 
        id: operationId, 
        message: "Direct command logged" 
      });
    }

    // Regular operation flow
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO operations (op_type, cmd, product_id, cell_id, status, priority, started_at)
       VALUES (?, ?, ?, ?, 'PROCESSING', ?, NOW())`,
      [op_type, cmd, product_id || null, cell_id || null, priority]
    );

    operationId = result.insertId;
    await connection.commit();

    // Broadcast operation start
    broadcast({ 
      type: "operation_update", 
      operation: { 
        id: operationId, 
        status: "PROCESSING", 
        op_type, 
        cmd 
      } 
    });

    // Update arm state
    armState.currentOperation = operationId;

    // Send command to ESP32
    let esp32Resp;
    try {
      esp32Resp = await sendCommandToESP32(cmd);
    } catch (errEsp) {
      const execMs = Date.now() - startTime;
      await connection.query(
        `UPDATE operations 
         SET status='ERROR', completed_at=NOW(), execution_time_ms=?, error_message=? 
         WHERE id=?`,
        [execMs, errEsp.message, operationId]
      );

      broadcast({ 
        type: "operation_update", 
        operation: { 
          id: operationId, 
          status: "ERROR",
          error_message: errEsp.message 
        } 
      });
      
      armState.currentOperation = null;
      return res.json({ 
        success: false, 
        id: operationId, 
        error: errEsp.message 
      });
    }

    // Operation completed successfully
    const execMs = Date.now() - startTime;
    await connection.query(
      `UPDATE operations 
       SET status='COMPLETED', completed_at=NOW(), execution_time_ms=? 
       WHERE id=?`,
      [execMs, operationId]
    );

    broadcast({
      type: "operation_update",
      operation: { 
        id: operationId, 
        status: "COMPLETED", 
        op_type, 
        cmd 
      },
    });

    armState.currentOperation = null;

    // Refresh warehouse data
    broadcastWarehouseData();

    return res.json({
      success: true,
      id: operationId,
      message: "Operation completed",
      execution_time_ms: execMs,
    });
  } catch (err) {
    console.error("Error POST /api/operations:", err);
    
    try {
      if (operationId) {
        await connection.query(
          `UPDATE operations SET status='ERROR', completed_at=NOW(), error_message=? WHERE id=?`,
          [String(err.message || err), operationId]
        );
      }
    } catch (_) {}
    
    return res.status(500).json({ 
      success: false, 
      error: "Server error: " + err.message 
    });
  } finally {
    connection.release();
  }
});

// Auto Tasks POST API
app.post("/api/auto-tasks", async (req, res) => {
  try {
    const {
      task_type,
      cell_id,
      product_id,
      product_rfid,
      quantity = 1,
      priority = 'MEDIUM',
      storage_strategy = 'NEAREST_EMPTY',
      parameters
    } = req.body;

    const [result] = await pool.query(`
      INSERT INTO auto_tasks 
      (task_type, cell_id, product_id, product_rfid, quantity, 
       priority, storage_strategy, parameters, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `, [
      task_type,
      cell_id || null,
      product_id || null,
      product_rfid || null,
      quantity,
      priority,
      storage_strategy,
      parameters ? JSON.stringify(parameters) : null
    ]);

    const [taskRows] = await pool.query(`
      SELECT t.*, c.label as cell_label, p.name as product_name
      FROM auto_tasks t
      LEFT JOIN cells c ON t.cell_id = c.id
      LEFT JOIN products p ON t.product_id = p.id
      WHERE t.id = ?
    `, [result.insertId]);

    res.json({ success: true, task: taskRows[0] });
    
  } catch (error) {
    console.error("Error creating auto task:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post("/api/cells/:id/assign", async (req, res) => {
  try {
    const cellId = req.params.id;
    const { product_id, quantity = 1 } = req.body;

    await pool.query(
      `UPDATE cells 
       SET product_id = ?, quantity = ?, status = 'OCCUPIED', updated_at = NOW()
       WHERE id = ?`,
      [product_id, quantity, cellId]
    );

    const [rows] = await pool.query(
      `SELECT c.*, p.name as product_name, p.rfid_uid
       FROM cells c
       LEFT JOIN products p ON c.product_id = p.id
       WHERE c.id = ?`,
      [cellId]
    );

    broadcast({ type: "cell_update", cell: rows[0] });
    res.json({ success: true, cell: rows[0] });
    
  } catch (error) {
    console.error("Error assigning product to cell:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get("/api/operations", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 200);

    const [rows] = await pool.query(
      `
      SELECT o.*,
             c.label AS cell_label,
             p.name  AS product_name
      FROM operations o
      LEFT JOIN cells c ON o.cell_id = c.id
      LEFT JOIN products p ON o.product_id = p.id
      ORDER BY o.id DESC
      LIMIT ?
    `,
      [limit]
    );

    res.json(rows);
  } catch (err) {
    console.error("Error /api/operations GET:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Loading Zone API
app.get("/api/loading-zone", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT lz.*, p.name AS product_name, p.sku, p.rfid_uid
      FROM loading_zone lz
      LEFT JOIN products p ON lz.product_id = p.id
      WHERE lz.id = 1
    `);

    const data =
      rows[0] || {
        id: 1,
        product_id: null,
        product_name: null,
        sku: null,
        rfid_uid: null,
        quantity: 0,
        ultrasonic_distance: null,
        servo_position: 90,
        status: "EMPTY",
        last_checked: null,
        updated_at: new Date().toISOString(),
      };

    res.json(data);
  } catch (err) {
    console.error("Error /api/loading-zone GET:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Conveyor Status API
app.get("/api/conveyor-status", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT cs.*, p.name AS product_name, p.sku, p.rfid_uid
      FROM conveyor_status cs
      LEFT JOIN products p ON cs.product_id = p.id
      WHERE cs.id = 1
      LIMIT 1
    `);

    res.json(
      rows[0] || {
        id: 1,
        has_product: false,
        product_id: null,
        product_name: null,
        sku: null,
        rfid_uid: null,
        mode: "MANUAL",
        state: "IDLE",
        last_detected_at: null,
      }
    );
  } catch (err) {
    console.error("Error GET /api/conveyor-status:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Auto Tasks API
app.get("/api/auto-tasks", async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const valid = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"];
    const where = status && valid.includes(status) ? "WHERE t.status = ?" : "";
    const params = status && valid.includes(status) ? [status] : [];

    const [rows] = await pool.query(
      `
      SELECT 
        t.*,
        c.label AS cell_label,
        p.name AS product_name
      FROM auto_tasks t
      LEFT JOIN cells c ON t.cell_id = c.id
      LEFT JOIN products p ON t.product_id = p.id
      ${where}
      ORDER BY t.id DESC
      LIMIT 200
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("Error GET /api/auto-tasks:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Status API
app.get("/api/status", async (req, res) => {
  try {
    const [cellsTotal] = await pool.query("SELECT COUNT(*) AS total FROM cells");
    const [cellsOcc] = await pool.query("SELECT COUNT(*) AS occupied FROM cells WHERE status = 'OCCUPIED'");
    const [prodTotal] = await pool.query("SELECT COUNT(*) AS total FROM products");
    const [opsPending] = await pool.query("SELECT COUNT(*) AS pending FROM operations WHERE status = 'PENDING'");
    const [tasksPending] = await pool.query("SELECT COUNT(*) AS pending FROM auto_tasks WHERE status = 'PENDING'");
    const [loadingZone] = await pool.query("SELECT status FROM loading_zone WHERE id = 1");
    const [conveyor] = await pool.query("SELECT * FROM conveyor_status WHERE id = 1");
    const [settings] = await pool.query("SELECT * FROM system_settings WHERE id = 1");

    res.json({
      cells: {
        total: cellsTotal[0].total,
        occupied: cellsOcc[0].occupied,
        available: cellsTotal[0].total - cellsOcc[0].occupied,
        ir_sensors_active: 12,
      },
      loading_zone: {
        status: loadingZone[0]?.status || "EMPTY",
        ultrasonic: true,
        servo: true,
      },
      conveyor: {
        has_product: conveyor[0]?.has_product || false,
        mode: conveyor[0]?.mode || "MANUAL",
        state: conveyor[0]?.state || "IDLE",
      },
      products: prodTotal[0].total,
      pending_operations: opsPending[0].pending,
      pending_tasks: tasksPending[0].pending,
      arm: armState,
      sensors: currentSensorData,
      esp32: {
        connected: isESP32Connected,
        url: ESP32_BASE_URL,
      },
      system: {
        storage_strategy: settings[0]?.storage_strategy || "NEAREST_EMPTY",
        auto_mode: settings[0]?.auto_mode || false,
        conveyor_manual_control: settings[0]?.conveyor_manual_control || false,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error /api/status:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Clear Tasks API
app.post("/api/auto-tasks/clear", async (req, res) => {
  try {
    await pool.query("DELETE FROM auto_tasks WHERE status IN ('PENDING', 'PROCESSING')");
    broadcast({ type: "tasks_cleared" });
    res.json({ success: true, message: "All pending tasks cleared" });
  } catch (err) {
    console.error("Error clearing tasks:", err);
    res.status(500).json({ error: "Database error" });
  }
});
app.post('/api/enhanced-tasks', async (req, res) => {
  try {
    const {
      task_type,
      cell_id,
      product_id,
      product_rfid,
      quantity = 1,
      target_quantity = 1,
      priority = 'MEDIUM',
      storage_strategy,
      parameters
    } = req.body;
    
    // Allowed tasks only (removed REORGANIZE_WAREHOUSE and LOAD_RETURN per final requirement)
    const validTasks = [
      'STOCK_FROM_CONVEYOR',
      'RETRIEVE_TO_LOADING',
      'MOVE_TO_LOADING'
    ];
    
    if (!validTasks.includes(task_type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid task type. Valid types: ${validTasks.join(', ')}`
      });
    }
    
    const [result] = await pool.query(`
      INSERT INTO auto_tasks (
        task_type, cell_id, product_id, product_rfid,
        quantity, target_quantity, priority, status,
        storage_strategy, parameters
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `, [
      task_type,
      cell_id || null,
      product_id || null,
      product_rfid || null,
      quantity,
      target_quantity,
      priority,
      storage_strategy || 'NEAREST_EMPTY',
      parameters ? JSON.stringify(parameters) : null
    ]);
    
    const [taskRows] = await pool.query(`
      SELECT t.*, c.label as cell_label, p.name as product_name
      FROM auto_tasks t
      LEFT JOIN cells c ON t.cell_id = c.id
      LEFT JOIN products p ON t.product_id = p.id
      WHERE t.id = ?
    `, [result.insertId]);
    
    const newTask = taskRows[0];
  
    broadcast({ type: "task_update", task: newTask });
    
    res.json({ success: true, task: newTask });
    
  } catch (error) {
    console.error("Error creating enhanced task:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Product Locations API
app.get('/api/product-locations', async (req, res) => {
  try {
    const { rfid_uid, product_id } = req.query;
    
    let query = `
      SELECT pl.*, 
             p.name as product_name,
             p.sku,
             c.label as cell_label,
             c.row_num,
             c.col_num,
             lz.status as loading_zone_status
      FROM product_locations pl
      JOIN products p ON pl.product_id = p.id
      LEFT JOIN cells c ON pl.cell_id = c.id
      LEFT JOIN loading_zone lz ON pl.loading_zone_id = lz.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (rfid_uid) {
      query += ' AND pl.rfid_uid = ?';
      params.push(rfid_uid);
    }
    
    if (product_id) {
      query += ' AND pl.product_id = ?';
      params.push(product_id);
    }
    
    query += ' ORDER BY pl.last_updated DESC';
    
    const [rows] = await pool.query(query, params);
    
    res.json({ success: true, locations: rows });
    
  } catch (error) {
    console.error("Error fetching product locations:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// Storage Strategy (GET current)
app.get("/api/storage-strategy", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT storage_strategy FROM system_settings WHERE id = 1"
    );
    const strategy = rows?.[0]?.storage_strategy || "NEAREST_EMPTY";
    res.json({ success: true, strategy });
  } catch (err) {
    console.error("Error getting storage strategy:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Storage Strategy API
app.post("/api/storage-strategy", async (req, res) => {
  try {
    const normalized = normalizeStrategy(req.body?.strategy);
    const validStrategies = ["NEAREST_EMPTY","FIXED"];
    
    if (!validStrategies.includes(normalized)) {
      return res.status(400).json({ success: false, error: `Invalid strategy` });
    }

    await pool.query("UPDATE system_settings SET storage_strategy = ? WHERE id = 1", [normalized]);

    armState.storageStrategy = normalized;
    currentSensorData.storageStrategy = normalized;

    if (ESP32_BASE_URL && isESP32Connected) {
      try {
        const strategyCmd = normalized === "AI_OPTIMIZED" ? "AI" :
                          normalized === "FIXED" ? "FIXED" : "NEAREST";
        const command = `STRATEGY ${strategyCmd}`;
        await sendCommandToESP32(command);
      } catch (err) {
        console.error("Failed to send strategy to ESP32:", err);
      }
    }

    broadcast({
      type: "strategy_update",
      strategy: normalized,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, strategy: normalized });
  } catch (err) {
    console.error("Error setting storage strategy:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== MANUAL: Stock From Conveyor (one-shot) ==================
// This runs the SAME stock cycle used by Auto (sensor-driven on the Mega),
// but is triggered directly from the Manual UI with a strategy popup.
// Flow on Mega: wait LDR1 -> move 12cm -> read RFID -> move to LDR2 -> pick & place.
app.post("/api/manual/stock-from-conveyor", async (req, res) => {
  try {
    const raw = String(req.body?.strategy || "NEAREST_EMPTY").toUpperCase().trim();
    const strategy = raw === "FIXED" ? "FIXED" : "NEAREST_EMPTY";

    if (!ESP32_BASE_URL || !isESP32Connected) {
      return res.status(400).json({ success: false, error: "ESP32 not connected" });
    }

    // Persist strategy (so UI + DB stay consistent)
    await pool.query(
      "UPDATE system_settings SET storage_strategy = ? WHERE id = 1",
      [strategy]
    );

    // Apply strategy on Mega
    if (strategy === "FIXED") {
      await sendCommandToESP32("STRATEGY FIXED");
    } else {
      await sendCommandToESP32("STRATEGY NEAREST");
    }

    // Start the conveyor-driven one-shot cycle on the Mega.
    // Flow on Mega: wait LDR1 -> move 12cm -> read RFID -> move to LDR2 -> pick & place -> AUTO_ONESHOT_DONE
    // IMPORTANT: respond immediately (UI should update via WS telemetry/state).
    await sendCommandToESP32("AUTO_ONESHOT_START");

    // Immediate response to avoid UI hanging
    res.json({ success: true, started: true, strategy });
  } catch (err) {
    console.error("Error /api/manual/stock-from-conveyor:", err);
    res.status(500).json({ success: false, error: err.message || "Server error" });
  }
});


// Conveyor Manual Control API
app.post("/api/conveyor/manual", async (req, res) => {
  try {
    const { action } = req.body;

    if (!ESP32_BASE_URL || !isESP32Connected) {
      return res.status(400).json({ success: false, error: "ESP32 not connected" });
    }

    let command;
    switch (action) {
      case "move":
        command = "CONVEYOR_MOVE";
        break;
      case "stop":
        command = "CONVEYOR_STOP";
        break;
      default:
        return res.status(400).json({
          success: false,
          error: "Invalid action. Use 'move' or 'stop'",
        });
    }

    await sendCommandToESP32(command);

    await pool.query(
      `UPDATE conveyor_status 
       SET mode = 'MANUAL',
           state = ?,
           updated_at = NOW()
       WHERE id = 1`,
      [action === "move" ? "MANUAL_MODE" : "IDLE"]
    );

    res.json({
      success: true,
      action,
      message: `Conveyor ${action} command sent`,
    });
  } catch (err) {
    console.error("Error controlling conveyor:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Loading Zone Control API
app.post("/api/loading-zone/control", async (req, res) => {
  try {
    const { action } = req.body;

    if (!ESP32_BASE_URL || !isESP32Connected) {
      return res.status(400).json({ success: false, error: "ESP32 not connected" });
    }

    let command;
    switch (action) {
      case "open":
        command = "LOADING_OPEN";
        await pool.query("UPDATE loading_zone SET servo_position = 180, updated_at = NOW() WHERE id = 1");
        break;
      case "close":
        command = "LOADING_CLOSE";
        await pool.query("UPDATE loading_zone SET servo_position = 90, updated_at = NOW() WHERE id = 1");
        break;
      case "check":
        command = "CHECK_LOADING";
        break;
      default:
        return res.status(400).json({
          success: false,
          error: "Invalid action. Use 'open', 'close', or 'check'",
        });
    }

    await sendCommandToESP32(command);

    await pool.query(
      `INSERT INTO operations (op_type, cmd, status, priority)
       VALUES ('LOADING_ZONE_OPERATION', ?, 'COMPLETED', 'LOW')`,
      [command]
    );

    res.json({ success: true, action, message: `Loading zone ${action} command sent` });
  } catch (err) {
    console.error("Error controlling loading zone:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Mode Control API
// ======== AUTO MODE CONTROL ========
app.post("/api/mode", async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode || !["manual", "auto"].includes(mode)) {
      return res.status(400).json({ error: "Invalid mode" });
    }

    armState.mode = mode;
    await pool.query("UPDATE system_settings SET auto_mode = ? WHERE id = 1", [mode === "auto"]);

    // مهم:
    // - تغيير MODE فقط (AUTO/MANUAL) ما لازم يبدأ تنفيذ التاسكات.
    // - التشغيل/الإيقاف الفعلي للأوتو (AUTO START / AUTO STOP) صار من endpoints منفصلة.
    try {
      await sendCommandToESP32(`MODE ${mode.toUpperCase()}`);
    } catch (err) {
      console.error("Error sending mode to ESP32:", err);
    }

    broadcast({ type: "mode_update", mode, armState });
    res.json({ success: true, mode });
  } catch (err) {
    console.error("Error /api/mode:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ======== AUTO START/STOP (تشغيل تنفيذ الكيو) ========
app.post("/api/auto/start", async (req, res) => {
  try {
    // لازم يكون المود AUTO أولاً
    armState.mode = "auto";
    await pool.query("UPDATE system_settings SET auto_mode = 1 WHERE id = 1");

    if (ESP32_BASE_URL && isESP32Connected) {
      await sendCommandToESP32("AUTO START");
    }

    startAutoTaskProcessor();
    broadcast({ type: "auto_run", running: true });
    res.json({ success: true, running: true });
  } catch (err) {
    console.error("Error /api/auto/start:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/api/auto/stop", async (req, res) => {
  try {
    await pool.query("UPDATE system_settings SET auto_mode = 0 WHERE id = 1");

    if (ESP32_BASE_URL && isESP32Connected) {
      await sendCommandToESP32("AUTO STOP");
    }

    stopAutoTaskProcessor();
    broadcast({ type: "auto_run", running: false });
    res.json({ success: true, running: false });
  } catch (err) {
    console.error("Error /api/auto/stop:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Sensor Update API
app.post("/api/sensors/update", async (req, res) => {
  try {
    const {
      ldr1,
      ldr2,
      rfid,
      conveyorState,
      armStatus,
      currentOperation,
      loadingZoneOccupied,
      storageStrategy,
      cells,
      targetCell,
    } = req.body;


    // Track Loading Zone edge (for reliable product caching)
    const prevLoadingZoneOccupied = !!currentSensorData?.loadingZoneOccupied;

    const strategy = normalizeStrategy(storageStrategy) || armState.storageStrategy || "NEAREST_EMPTY";
    const grid = to2DCells(cells);
    try {
  // ✅ reconcile DB with IR (debounced)
  const [dbCells] = await pool.query(
    "SELECT id,row_num,col_num,status,product_id FROM cells ORDER BY row_num,col_num"
  );

  for (const c of dbCells) {
    const r = c.row_num - 1;
    const col = c.col_num - 1;
    const irOcc = !!(grid[r] && grid[r][col]);

    if (!irOcc) irFalseCount[r][col] = Math.min(irFalseCount[r][col] + 1, 10);
    else irFalseCount[r][col] = 0;

    // إذا DB شايفها OCCUPIED بس IR صار فاضي 4 مرات متتالية (~ 4 updates)
    if (c.status === "OCCUPIED" && !irOcc && irFalseCount[r][col] >= 2) {
      await pool.query(
        "UPDATE cells SET status='EMPTY', product_id=NULL, quantity=0, updated_at=NOW() WHERE id=?",
        [c.id]
      );
      // broadcast update
      broadcast({ type: "cell_update", cell: { ...c, status: "EMPTY", display_status: "EMPTY", product_id: null, quantity: 0 } });
    }
  }
} catch (e) {
  console.warn("IR reconcile skipped:", e.message);
}


    // Update sensor data
    currentSensorData = {
      ldr1: !!ldr1,
      ldr2: !!ldr2,
      rfid: rfid || null,
      conveyorState: conveyorState || "IDLE",
      armStatus: armStatus || "READY",
      currentOperation: currentOperation || "",
      loadingZoneOccupied: !!loadingZoneOccupied,
      storageStrategy: strategy,
      cells: grid,
      targetCell: targetCell || null,
      lastUpdate: new Date().toISOString(),
    };

    // Update arm state
    if (armStatus) armState.status = armStatus;
    if (currentOperation) armState.currentOperation = currentOperation;

    // Update strategy if changed
    if (storageStrategy && strategy !== armState.storageStrategy) {
      armState.storageStrategy = strategy;
      await pool.query(
        "UPDATE system_settings SET storage_strategy = ? WHERE id = 1",
        [strategy]
      );
    }

    // Broadcast updates
    broadcast({ type: "sensor_update", data: currentSensorData });
    broadcast({ type: "arm_status", armState });

    
    // Update conveyor status (don't crash on lock timeouts)
    const hasProduct = currentSensorData.ldr1 || currentSensorData.ldr2;
    try {
      await pool.query(
        `UPDATE conveyor_status
         SET has_product = ?,
             state = ?,
             product_id = IF(? = 0, NULL, product_id),
             last_detected_at = NOW()
         WHERE id = 1`,
        [hasProduct ? 1 : 0, conveyorState || "IDLE", hasProduct ? 1 : 0]
      );
    } catch (e) {
      if (e.code !== "ER_LOCK_WAIT_TIMEOUT") throw e;
      console.warn("⚠️ conveyor_status update skipped (lock timeout)");
    }


    // Update RFID if detected
    // NOTE:
    // - The Mega sends RFID as dotted-decimal bytes (e.g. "252.53.92.3")
    // - If the tag is not yet in `products`, we STILL want to show it on the website
    //   (otherwise the user thinks "RFID not read").
    if (rfid) {
      const [products] = await pool.query(
        "SELECT * FROM products WHERE rfid_uid = ?",
        [rfid]
      );

      if (products.length > 0) {
        const product = products[0];
        await pool.query(
          `UPDATE conveyor_status
           SET product_id = ?, product_rfid = ?
           WHERE id = 1`,
          [product.id, rfid]
        );

        broadcast({
          type: "rfid_detected",
          tag: rfid,
          // Prefer the symbol coming from ESP32 (derived from TAG_IDS), fallback to product name.
          symbol: (currentSensorData?.currentRfidSymbol || (product.name ? product.name.charAt(0).toUpperCase() : "?")),
          product,
        });
      } else {
        // No product row yet -> still broadcast and store product_rfid
        await pool.query(
          `UPDATE conveyor_status
           SET product_id = NULL, product_rfid = ?
           WHERE id = 1`,
          [rfid]
        );
        broadcast({
          type: "rfid_detected",
          tag: rfid,
          symbol: (currentSensorData?.currentRfidSymbol || "?"),
          product: null,
        });
      }
    }

    // Update loading zone (status) + keep product info consistent
    const lzStatus = loadingZoneOccupied ? "OCCUPIED" : "EMPTY";
    await pool.query(
      `UPDATE loading_zone
       SET status = ?,
           last_checked = NOW(),
           updated_at = NOW()
       WHERE id = 1`,
      [lzStatus]
    );

    // If the sensor says EMPTY -> clear product info (so UI shows truth)
    if (!loadingZoneOccupied) {
      await pool.query(
        "UPDATE loading_zone SET product_id=NULL, quantity=0, rfid_uid_cache=NULL, product_name_cache=NULL, updated_at=NOW() WHERE id=1"
      );
    }

    // ✅ Fallback: if Loading Zone just became occupied (edge), cache the product info using the last seen RFID.
    // This helps the UI show the product even if firmware does not emit PRODUCT_IN_LOADING:<rfid>.
    if (loadingZoneOccupied && !prevLoadingZoneOccupied) {
      const tag = String(rfid || "").trim();
      if (tag && tag !== "0" && tag.toLowerCase() !== "null") {
        try {
          let productId = null;
          let productName = null;

          const [prodRows] = await pool.query(
            "SELECT id, name FROM products WHERE rfid_uid = ? LIMIT 1",
            [tag]
          );

          if (prodRows.length) {
            productId = prodRows[0].id;
            productName = prodRows[0].name || null;
          } else {
            const [ins] = await pool.query(
              "INSERT INTO products (name, rfid_uid, created_at, updated_at) VALUES (?, ?, NOW(), NOW())",
              [`RFID ${tag}`, tag]
            );
            productId = ins.insertId;
            productName = `RFID ${tag}`;
          }

          await pool.query(
            "UPDATE loading_zone SET status='OCCUPIED', product_id=?, quantity=GREATEST(quantity,1), rfid_uid_cache=?, product_name_cache=?, updated_at=NOW() WHERE id=1",
            [productId, tag, tag, (productName || null)]
          );

          try { await updateProductLocation(tag, "IN_LOADING_ZONE", null, 1); } catch (_) {}
        } catch (e) {
          console.warn("Loading Zone edge-cache failed:", e.message);
        }
      }
    }

    broadcast({ type: "loading_zone_state", occupied: !!loadingZoneOccupied });

    // ✅ Auto-return from Loading Zone is disabled (no extra tasks)

    // Broadcast warehouse data (throttled to prevent UI jitter)
    broadcastWarehouseDataThrottled(500);

    // ✅ Track product inside Loading Zone from Mega (PRODUCT_IN_LOADING:RFID)
    // This ensures you always know which product is currently in the Loading Zone.
    try {
      const opStrLZ = String(currentSensorData.currentOperation || "");

      // When Mega sends: PRODUCT_IN_LOADING:<rfid>
      const mLZ = opStrLZ.match(/PRODUCT_IN_LOADING:([^\s]+)/i);
      if (mLZ && mLZ[1]) {
        const rfidTag = String(mLZ[1]).trim();
        if (rfidTag) {
          // Ensure product exists
          let productId = null;
          let productName = null;
          const [prodRows] = await pool.query(
            "SELECT id, name FROM products WHERE rfid_uid = ? LIMIT 1",
            [rfidTag]
          );
          if (prodRows.length) {
            productId = prodRows[0].id;
            productName = prodRows[0].name || null;
          } else {
            const [ins] = await pool.query(
              "INSERT INTO products (name, rfid_uid, created_at, updated_at) VALUES (?, ?, NOW(), NOW())",
              [`RFID ${rfidTag}`, rfidTag]
            );
            productId = ins.insertId;
            productName = `RFID ${rfidTag}`;
          }

          await pool.query(
            "UPDATE loading_zone SET status='OCCUPIED', product_id=?, quantity=GREATEST(quantity,1), rfid_uid_cache=?, product_name_cache=?, updated_at=NOW() WHERE id=1",
            [productId, rfidTag, rfidTag, (productName || null)]
          );

          await updateProductLocation(rfidTag, "IN_LOADING_ZONE", null, 1);
          broadcastWarehouseDataThrottled(500);
        }
      }

      // When Mega sends completion that empties loading zone
      if (/LOADING_TAKE_COMPLETE/i.test(opStrLZ)) {
        await pool.query(
          "UPDATE loading_zone SET status='EMPTY', product_id=NULL, quantity=0, rfid_uid_cache=NULL, product_name_cache=NULL, updated_at=NOW() WHERE id=1"
        );
        broadcastWarehouseDataThrottled(500);
      }
    } catch (e) {
      console.warn("Loading Zone product tracking skipped:", e.message);
    }

// ✅ If Mega completed AUTO_STOCK and told us target cell, update DB with product + RFID
    try {
      const opStr = String(currentSensorData.currentOperation || "");
      const tc = String(currentSensorData.targetCell || "");
      const m = opStr.match(/AUTO_STOCK_COMPLETE:?(.*)$/);
      if (m && tc) {
        const rfidTag = (m[1] || currentSensorData.rfid || "").trim();
        const nums = tc.match(/(\d+)\s*[: ,]\s*(\d+)/) || tc.match(/C(\d+)[: ]R(\d+)/i) || tc.match(/(\d+)\D+(\d+)/);
        if (rfidTag && nums) {
          const col = parseInt(nums[1], 10);
          const row = parseInt(nums[2], 10);

          // Ensure product exists
          let productId = null;
          let productName = null;
          const [prodRows] = await pool.query("SELECT id, name FROM products WHERE rfid_uid = ? LIMIT 1", [rfidTag]);
          if (prodRows.length) {
            productId = prodRows[0].id;
            productName = prodRows[0].name || null;
          } else {
            const [ins] = await pool.query(
              "INSERT INTO products (name, rfid_uid, created_at, updated_at) VALUES (?, ?, NOW(), NOW())",
              [`RFID ${rfidTag}`, rfidTag]
            );
            productId = ins.insertId;
            productName = `RFID ${rfidTag}`;
          }

          const [cellRows] = await pool.query(
            "SELECT id FROM cells WHERE row_num = ? AND col_num = ? LIMIT 1",
            [row, col]
          );
          if (cellRows.length) {
            await pool.query(
              "UPDATE cells SET status='OCCUPIED', product_id=?, rfid_uid_cache=?, product_name_cache=?, quantity=GREATEST(quantity,1), updated_at=NOW() WHERE id=?",
              [productId, rfidTag, (productName || null), cellRows[0].id]
            );
            await updateProductLocation(rfidTag, "STOCKED", cellRows[0].id);
            broadcastWarehouseDataThrottled(500);
          }
        }
      }
    } catch (e) {
      console.warn("AUTO_STOCK mapping skipped:", e.message);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating sensors:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Cell Action API
app.post("/api/cell-action", async (req, res) => {
  try {
    const { action, row, col, rfid, quantity } = req.body;
    const r = parseInt(row, 10);
    const c = parseInt(col, 10);
    const qty = Math.max(1, parseInt(quantity || 1, 10) || 1);

    if (!action || !["PLACED", "TAKEN"].includes(String(action))) {
      return res.status(400).json({ success: false, error: "Invalid action" });
    }
    
    if (!(r >= 1 && r <= 3 && c >= 1 && c <= 4)) {
      return res.status(400).json({ success: false, error: "Invalid row/col" });
    }

    const [cellRows] = await pool.query(
      "SELECT id, product_id, quantity FROM cells WHERE row_num=? AND col_num=? LIMIT 1",
      [r, c]
    );
    
    if (!cellRows.length) {
      return res.status(404).json({ success: false, error: "Cell not found" });
    }
    
    const cellId = cellRows[0].id;

    if (action === "TAKEN") {
      await pool.query(
        "UPDATE cells SET product_id=NULL, quantity=0, status='EMPTY', updated_at=NOW() WHERE id=?",
        [cellId]
      );
    } else {
      let productId = null;
      let productName = null;
      if (rfid) {
        const [p] = await pool.query("SELECT id, name FROM products WHERE rfid_uid=? LIMIT 1", [String(rfid)]);
        if (p.length) {
          productId = p[0].id;
          productName = p[0].name || null;
        }
      }

      if (productId) {
        await pool.query(
          "UPDATE cells SET product_id=?, rfid_uid_cache=?, product_name_cache=?, quantity=GREATEST(1, ?) , status='OCCUPIED', updated_at=NOW() WHERE id=?",
          [productId, String(rfid), (productName || null), qty, cellId]
        );
      } else {
        await pool.query(
          "UPDATE cells SET status='OCCUPIED', rfid_uid_cache=COALESCE(?, rfid_uid_cache), product_name_cache=COALESCE(?, product_name_cache), quantity=GREATEST(quantity, ?), updated_at=NOW() WHERE id=?",
          [rfid ? String(rfid) : null, productName || (rfid ? `RFID ${String(rfid)}` : null), qty, cellId]
        );
      }
    }

    const [rows] = await pool.query(
      `SELECT 
         c.*,
         p.name AS product_name,
         p.sku,
         p.rfid_uid,
         c.status AS display_status
       FROM cells c
       LEFT JOIN products p ON c.product_id = p.id
       WHERE c.id = ?`,
      [cellId]
    );

    const updatedCell = rows[0];
    broadcast({ type: "cell_update", cell: updatedCell });
    broadcastWarehouseData();

    res.json({ success: true, cell: updatedCell });
  } catch (err) {
    console.error("Error POST /api/cell-action:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Start Auto Task Processor API
app.post("/api/auto-tasks/start-processor", async (req, res) => {
  try {
    // Safety: do not run tasks unless auto_mode is ON
    const [settings] = await pool.query(
      "SELECT auto_mode FROM system_settings WHERE id = 1"
    );
    const autoModeOn = !!settings?.[0]?.auto_mode;

    if (!autoModeOn) {
      return res.json({
        success: false,
        message: "Auto mode is OFF. Tasks will wait until you press Start Auto Mode.",
        timestamp: new Date().toISOString(),
      });
    }

    startAutoTaskProcessor();
    res.json({
      success: true,
      message: "Auto task processor started",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error starting task processor:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop Auto Task Processor API
app.post("/api/auto-tasks/stop-processor", async (req, res) => {
  try {
    stopAutoTaskProcessor();
    res.json({ 
      success: true, 
      message: "Auto task processor stopped",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error stopping task processor:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Auto Tasks Queue API
app.get("/api/auto-tasks/queue", async (req, res) => {
  try {
    const [tasks] = await pool.query(`
      SELECT t.*,
             c.label as cell_label,
             p.name as product_name,
             p.rfid_uid
      FROM auto_tasks t
      LEFT JOIN cells c ON t.cell_id = c.id
      LEFT JOIN products p ON t.product_id = p.id
      WHERE t.status IN ('PENDING', 'PROCESSING')
      ORDER BY 
        CASE t.priority
          WHEN 'URGENT' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
          ELSE 5
        END,
        t.created_at
    `);

    res.json(tasks);
  } catch (err) {
    console.error("Error getting task queue:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ESP32 Registration API
app.get("/api/esp32/register", (req, res) => {
  const { ip } = req.query;
  if (!ip) {
    return res.status(400).json({
      success: false,
      error: "Missing 'ip' query parameter",
    });
  }

  ESP32_BASE_URL = `http://${ip}`;
  isESP32Connected = true;
  console.log(`✅ ESP32 registered at ${ESP32_BASE_URL}`);

  broadcast({
    type: "esp32_status",
    connected: true,
    url: ESP32_BASE_URL,
  });

  res.json({
    success: true,
    esp32_base_url: ESP32_BASE_URL,
    message: "ESP32 registered successfully",
  });
});

// Health Check API
app.get("/health", async (req, res) => {
  try {
    const [r] = await pool.query("SELECT 1 as ok");
    res.json({ 
      ok: true, 
      db: r?.[0]?.ok === 1, 
      esp32: isESP32Connected, 
      ts: new Date().toISOString() 
    });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      db: false, 
      esp32: isESP32Connected, 
      error: e.message 
    });
  }
});

// ======== BROADCAST FUNCTIONS ========
async function broadcastWarehouseData() {
  try {
    const [cells] = await pool.query(`
      SELECT 
        c.*,
        p.name AS product_name,
        p.sku,
        p.rfid_uid,
        c.status AS display_status
      FROM cells c
      LEFT JOIN products p ON c.product_id = p.id
      ORDER BY c.row_num, c.col_num
    `);

    const [loadingZone] = await pool.query(`
      SELECT lz.*, p.name as product_name, p.sku
      FROM loading_zone lz
      LEFT JOIN products p ON lz.product_id = p.id
      WHERE lz.id = 1
    `);

    const [conveyorStatus] = await pool.query(`
      SELECT cs.*, p.name as product_name, p.sku
      FROM conveyor_status cs
      LEFT JOIN products p ON cs.product_id = p.id
      WHERE cs.id = 1
    `);

    const [settings] = await pool.query("SELECT * FROM system_settings WHERE id = 1");

    const liveCells = applyLiveCellStatus(cells);

    broadcast({
      type: "warehouse_data",
      cells: liveCells,
      loadingZone: loadingZone[0] || { id: 1, product_id: null, quantity: 0, status: "EMPTY" },
      conveyor: conveyorStatus[0] || { id: 1, has_product: false, mode: "MANUAL", state: "IDLE" },
      systemSettings: settings[0] || {},
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error broadcasting warehouse data:", err);
  }
}
// ======== AUTO TASK PROCESSOR LOOP ========
let isTaskProcessorRunning = false;
let isTaskExecuting = false; // prevent overlapping task execution

async function startAutoTaskProcessor() {
  if (isTaskProcessorRunning) return;
  
  isTaskProcessorRunning = true;
  console.log("Auto Task Processor Started");
  
  const processorLoop = async () => {
    if (!isTaskProcessorRunning) return;
    try {
      // Only run queued tasks when auto_mode is ON.
      // (Tasks can be added anytime; they will wait until user presses Start Auto Mode.)
      const [settings] = await pool.query(
        "SELECT auto_mode FROM system_settings WHERE id = 1"
      );
      const autoModeOn = !!settings?.[0]?.auto_mode;
      if (!autoModeOn) {
        setTimeout(processorLoop, 2000);
        return;
      }

      // Check if there are pending tasks
      const [pendingTasks] = await pool.query(
        "SELECT COUNT(*) as count FROM auto_tasks WHERE status = 'PENDING'"
      );
      
      if (pendingTasks[0].count > 0) {
        await processNextAutoTask();
      } else {
        // If no tasks, check again after 3 seconds
        setTimeout(processorLoop, 3000);
        return;
      }
      
      // Continue processing next task
      setTimeout(processorLoop, 2000);
    } catch (error) {
      console.error("Auto task processor error:", error);
      setTimeout(processorLoop, 5000);
    }
  };
  
  processorLoop();
}

function stopAutoTaskProcessor() {
  isTaskProcessorRunning = false;
  console.log(" Auto Task Processor Stopped");
}
// Auto Mode Status Check
async function checkAutoModeStatus() {
  try {
    const [settings] = await pool.query(
      "SELECT auto_mode FROM system_settings WHERE id = 1"
    );
    
    const autoMode = settings[0]?.auto_mode || false;
    
    if (autoMode && !isTaskProcessorRunning) {
      console.log("⚠️ Auto mode is ON but processor is not running. Starting...");
      startAutoTaskProcessor();
    }
  } catch (error) {
    console.error("Error checking auto mode status:", error);
  }
}

// ======== AUTO TASK PROCESSOR ========
async function processNextAutoTask() {
  if (!isTaskProcessorRunning) return;
  if (isTaskExecuting) return;

  // If a task is already PROCESSING in DB, do not start another one
  try {
    const [[{ cnt }]] = await pool.query("SELECT COUNT(*) AS cnt FROM auto_tasks WHERE status='PROCESSING'");
    if (cnt && cnt > 0) return;
  } catch (e) { /* ignore */ }

  isTaskExecuting = true;

  if (!isTaskProcessorRunning) return; 

  try {
    const [tasks] = await pool.query(`
      SELECT t.*,
             c.label as cell_label,
             p.name as product_name,
             p.rfid_uid
      FROM auto_tasks t
      LEFT JOIN cells c ON t.cell_id = c.id
      LEFT JOIN products p ON t.product_id = p.id
      WHERE t.status = 'PENDING'
      ORDER BY 
        CASE t.priority
          WHEN 'URGENT' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
          ELSE 5
        END,
        t.created_at
      LIMIT 1
    `);

    if (!tasks.length) return;

    await processEnhancedAutoTask(tasks[0]);
  } catch (err) {
    console.error("Error processing auto task:", err);
  } finally {
    isTaskExecuting = false;
    // 🔁 Immediately try next task (sequential, no skipping)
    if (isTaskProcessorRunning) {
      setTimeout(() => processNextAutoTask(), 200);
    }
  }
}


// ======== SERVER STARTUP ========
const server = app.listen(PORT, async () => {
  if (String(process.env.INIT_DB || "true").toLowerCase() === "true") {
    await initializeDatabase();
  }
  // إذا auto_mode محفوظ من قبل، شغّل الـ processor (بدون إرسال أوامر للـ ESP32 هنا)
  await checkAutoModeOnStart();
  console.log(`🚀 Server running on http://localhost:${PORT}`);

  // Periodic refresh (throttled) so UI stays up-to-date without jitter
  setInterval(() => broadcastWarehouseDataThrottled(1000), 3000);

  setInterval(async () => {
    if (isESP32Connected && ESP32_BASE_URL) {
      try {
        const url = `${ESP32_BASE_URL}/cmd?c=${encodeURIComponent("GET_STATUS")}`;
        await fetchWithTimeout(url, {}, 5000);
      } catch (err) {
        console.error("Failed to reach ESP32:", err);
        isESP32Connected = false;
        broadcast({
          type: "esp32_status",
          connected: false,
          url: ESP32_BASE_URL,
        });
      }
    }
  }, 10000);

  
});

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await pool.end();
  process.exit(0);
});