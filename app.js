// FILE: app.js - COMPLETE UPDATED VERSION
const API_BASE = window.location.origin;
const WS_URL = API_BASE.replace("http", "ws") + "/ws";

const state = {
  // Manual-only UI
  mode: "manual",
  cells: [],
  products: [],
  operations: [],
  autoTasks: [],
  loadingZone: null,
  conveyor: null,
  isConnected: false,
  esp32Connected: false,
  currentOperation: null,
  isLoading: false,
  autoModeRunning: false,
  storageStrategy: "NEAREST_EMPTY",
  sensorData: {
    ldr1: false,
    ldr2: false,
    rfid: null,
    conveyorState: "IDLE",
    armStatus: "READY",
    currentOperation: "",
    loadingZoneOccupied: false,
    storageStrategy: "NEAREST_EMPTY",
    cells: Array(3).fill().map(() => Array(4).fill(false))
  },
  irMemory: null
};

// ===== Manual Auto-Stock (Pick From Conveyor Auto) =====
// Requested behavior:
// - Show strategy popup (FIXED / NEAREST).
// - After Start: start one-shot cycle on the Mega.
//   The Mega itself waits for LDR1 -> move 12cm -> read RFID -> move to LDR2 -> pick & place.
// - Keep UI responsive and allow cancel.
let pendingManualAutoStock = {
  waiting: false,
  running: false,
  strategy: "NEAREST_EMPTY",
  awaitingDone: false,
  startedAt: 0,
  donePoll: null
};

let ws = null;
let reconnectTimeout = null;

const elements = {
  manualControls: document.getElementById("manual-controls"),
  modeStatus: document.getElementById("mode-status"),
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingTitle: document.getElementById("loading-title"),
  loadingMessage: document.getElementById("loading-message"),
  progressBar: document.getElementById("progress-bar"),
  currentStep: document.getElementById("current-step"),
  estimatedTime: document.getElementById("estimated-time"),
  cellsGrid: document.getElementById("cells-grid"),
  loadingZone: document.getElementById("loading-zone-content"),
  conveyorProduct: document.getElementById("conveyor-product"),
  taskQueue: document.getElementById("task-queue"),
  taskModal: document.getElementById("task-modal"),
  ldr1Indicator: document.getElementById("ldr1-indicator"),
  ldr2Indicator: document.getElementById("ldr2-indicator"),
  conveyorStatus: document.getElementById("conveyor-status"),
  rfidTag: document.getElementById("rfid-tag"),
  autoConveyorState: document.getElementById("auto-conveyor-state"),
  currentRfid: document.getElementById("current-rfid"),
  targetCell: document.getElementById("target-cell"),
  conveyor: document.getElementById("conveyor"),
  esp32Status: document.getElementById("esp32-status"),
  armStatus: document.getElementById("arm-status"),
  totalCells: document.getElementById("total-cells"),
  occupiedCells: document.getElementById("occupied-cells"),
  availableCells: document.getElementById("available-cells"),
  loadingStatus: document.getElementById("loading-status"),
  loadingZoneElement: document.getElementById("loading-zone-cell")

  ,loadingModal: document.getElementById("loading-modal")
  ,loadingModalTitle: document.getElementById("loading-modal-title")
  ,loadingAction: document.getElementById("loading-action")
  ,loadingSourceCell: document.getElementById("loading-source-cell")
  ,loadingTargetCell: document.getElementById("loading-target-cell")
  ,loadingModalInfo: document.getElementById("loading-modal-info")

};
// Auto-mode UI removed

// في init function
async function init() {
  setupEnhancedTaskHandlers();
  setupEventHandlers();
  
  connectWebSocket();
  await loadWarehouseData();
  
  setupConnectionStatus();
  setupAutoRefresh();
  
  showNotification("Smart Warehouse System Ready", "success");
}

function setupConnectionStatus() {
  if (!document.getElementById("strategy-badge")) {
    const modeStatus = document.getElementById("mode-status");
    if (modeStatus && modeStatus.parentNode) {
      const strategyBadge = document.createElement("span");
      strategyBadge.id = "strategy-badge";
      strategyBadge.className = "badge badge-green";
      strategyBadge.textContent = `Strategy: ${state.storageStrategy}`;
      modeStatus.parentNode.insertBefore(strategyBadge, modeStatus.nextSibling);
    }
  }
}

function setupAutoRefresh() {
  setInterval(async () => {
    if (state.isConnected) {
      await loadWarehouseData();
    }
  }, 10000);
}

// ========== WEBSOCKET CONNECTION ==========
function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("WebSocket connected");
      state.isConnected = true;
      updateConnectionStatus(true);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };

    ws.onmessage = (event) => {
      try {
        if (!event.data || (event.data[0] !== "{" && event.data[0] !== "[")) {
          console.warn("Non-JSON WS message:", event.data);
          return;
        }
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
      state.isConnected = false;
      updateConnectionStatus(false);
      reconnectTimeout = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  } catch (error) {
    console.error("Failed to connect WebSocket:", error);
  }
}




function updateConnectionStatus(connected) {
  if (connected) {
    elements.esp32Status.textContent = "ESP32: Connected (WS)";
    elements.esp32Status.className = "badge badge-green";
  } else {
    elements.esp32Status.textContent = "ESP32: Disconnected";
    elements.esp32Status.className = "badge badge-red";
  }
}

// ========== WEBSOCKET MESSAGE HANDLER ==========
function handleWebSocketMessage(data) {
  switch (data.type) {
    case "init":
      handleInitMessage(data);
      break;
    case "mode_update":
      applyModeUI(data.mode);
      break;
    case "strategy_update":
      state.storageStrategy = data.strategy;
      updateStorageStrategyUI(data.strategy);
      break;

      case "loading_zone_state":
     updateLoadingZoneVisual(data.occupied);
     break;

    case "operation_update":
      updateOperationStatus(data.operation);
      break;
    case "warehouse_data":
      updateWarehouseData(data);
      break;
    case "cell_update":
      updateCell(data.cell);
      break;
    case "sensor_update":
      updateSensors(data.data);
      break;
    case "rfid_detected":
      updateRFID(data.tag, data.symbol, data.product, data.targetCell);
      break;
    case "esp32_status":
      updateESP32Status(data.connected);
      break;
    case "task_update":
      updateAutoTask(data.task);
      break;
    case "conveyor_update":
      updateConveyorUI(data.product);
      break;
    case "loading_zone_update":
      state.loadingZone = data.data;
      renderLoadingZone();
      break;
    case "arm_status":
      updateArmStatus(data.armState);
      break;
    case "inventory_report":
      showNotification("Inventory check completed", "success");
      break;
    default:
      console.log("Unknown WS message:", data);
  }
}

function handleInitMessage(data) {
  if (data.armState) {
    if (data.armState.mode) applyModeUI(data.armState.mode);
    if (data.armState.status) updateArmStatus(data.armState.status);
    if (data.armState.storageStrategy) {
      state.storageStrategy = data.armState.storageStrategy;
      updateStorageStrategyUI(data.armState.storageStrategy);
    }
  }
  if (data.sensorData) updateSensors(data.sensorData);
  if (data.esp32Connected !== undefined) updateESP32Status(data.esp32Connected);
}

// ========== MODE MANAGEMENT ==========
function applyModeUI(mode) {
  state.mode = mode;
  // بعض نسخ الواجهة ما فيها modeSelect / autoControls (اتشالت من التصميم)
  // فبدنا نخلي الموضوع آمن وما يوقع الـ JS.
  const modeSelect = document.getElementById("mode-select");
  if (modeSelect) modeSelect.value = mode;

  if (elements.modeStatus) {
    elements.modeStatus.textContent =
      mode.charAt(0).toUpperCase() + mode.slice(1) + " Mode";
  }

  // في ملفك الحالي: manual-controls موجود، و auto-controls مش موجود.
  const autoControls = document.getElementById("auto-controls");

  if (mode === "manual") {
    if (elements.manualControls) elements.manualControls.style.display = "block";
    if (autoControls) autoControls.style.display = "none";
    if (elements.modeStatus) elements.modeStatus.className = "badge badge-blue";
  } else {
    if (elements.manualControls) elements.manualControls.style.display = "none";
    if (autoControls) autoControls.style.display = "block";
    if (elements.modeStatus) elements.modeStatus.className = "badge badge-yellow";
  }
}

// ========== STATUS UPDATES ==========
function updateESP32Status(connected) {
  state.esp32Connected = connected;
  if (connected) {
    elements.esp32Status.textContent = "ESP32: Connected";
    elements.esp32Status.className = "badge badge-green";
  } else {
    elements.esp32Status.textContent = "ESP32: Disconnected";
    elements.esp32Status.className = "badge badge-red";
  }
}

function updateArmStatus(armState) {
  if (armState && armState.status) {
    elements.armStatus.textContent = `Arm: ${armState.status}`;
    
    if (armState.status.includes("Ready") || armState.status.includes("Idle") || armState.status.includes("COMPLETE")) {
      elements.armStatus.className = "badge badge-green";
    } else if (armState.status.includes("Moving") || armState.status.includes("Busy") || armState.status.includes("HOMING") || armState.status.includes("PROCESSING")) {
      elements.armStatus.className = "badge badge-yellow";
    } else if (armState.status.includes("Error")) {
      elements.armStatus.className = "badge badge-red";
    } else {
      elements.armStatus.className = "badge badge-gray";
    }
  }
  
  if (armState && armState.storageStrategy) {
    state.storageStrategy = armState.storageStrategy;
    updateStorageStrategyUI(armState.storageStrategy);
  }
}

function updateStorageStrategyUI(strategy) {
  const strategyBadge = document.getElementById("strategy-badge");
  if (!strategyBadge) return;
  
  strategyBadge.textContent = `Strategy: ${strategy}`;
  
  const colors = {
    "NEAREST_EMPTY": "badge-green",
    "AI_OPTIMIZED": "badge-purple",
    "FIXED": "badge-gray"
  };
  
  strategyBadge.className = `badge ${colors[strategy] || "badge-gray"}`;
  
  const strategySelect = document.getElementById("strategy-select");
  if (strategySelect) strategySelect.value = strategy;
}

// ========== DATA LOADING ==========
async function loadWarehouseData() {
  try {
    const requests = [
      apiCall("/api/cells"),
      apiCall("/api/products"),
      apiCall("/api/operations?limit=20"),
      apiCall("/api/loading-zone"),
      apiCall("/api/conveyor-status"),
      apiCall("/api/auto-tasks?status=PENDING"),
      apiCall("/api/storage-strategy"),
      apiCall("/api/status")
    ];

    const [
      cellsData,
      productsData,
      operationsData,
      loadingZoneData,
      conveyorData,
      autoTasksData,
      strategyData,
      statusData
    ] = await Promise.all(requests);

    state.cells = cellsData;
    state.products = productsData;
    state.operations = operationsData;
    state.loadingZone = loadingZoneData;
    state.conveyor = conveyorData;
    state.autoTasks = autoTasksData;
    state.storageStrategy = strategyData.strategy;

    renderCells();
    renderProducts();
    renderOperations();
    renderLoadingZone();
    renderAutoTasks();
    updateConveyorUI(conveyorData);
    updateStorageStrategyUI(strategyData.strategy);
    updateStats();
    updateCellSelects();
    updateProductSelects();
    updateSystemInfo(statusData);

  } catch (error) {
    console.error("Failed to load warehouse data:", error);
    showNotification("Error loading data", "warning");
  }
}

// ========== RENDER FUNCTIONS ==========
function renderCells() {
  elements.cellsGrid.innerHTML = "";

  state.cells.forEach((cell) => {
    const cellElement = document.createElement("div");
    const ds = (cell.display_status || cell.status || "EMPTY");
    const isReserved = String(ds).toUpperCase() === "RESERVED";
    const isOcc = ["OCCUPIED", "MAINTENANCE"].includes(String(ds).toUpperCase());
    cellElement.className = `cell ${isOcc ? "occupied" : (isReserved ? "reserved" : "empty")}`;
    cellElement.dataset.cellId = cell.id;
    cellElement.dataset.row = cell.row_num;
    cellElement.dataset.col = cell.col_num;

    const header = document.createElement("div");
    header.className = "cell-header";
    header.innerHTML = `
      <span>${cell.label}</span>
      <span class="cell-status">R${cell.row_num}C${cell.col_num}</span>
    `;

    const body = document.createElement("div");
    body.className = "cell-body";

    if (cell.product_id) {
      body.innerHTML = `
        <div class="cell-product-name">${cell.product_name || cell.product_name_cache || 'Unknown'}</div>
        <div class="cell-qty">Qty: ${cell.quantity}</div>
        ${cell.sku ? `<div class="cell-sku">SKU: ${cell.sku}</div>` : ''}
        ${(cell.rfid_uid || cell.rfid_uid_cache) ? `<div class="cell-sku">RFID: ${cell.rfid_uid || cell.rfid_uid_cache}</div>` : ''}
      `;
    } 

    const sensorIndicator = document.createElement("div");
    sensorIndicator.className = "cell-sensor";
    sensorIndicator.innerHTML = `
      <small>IR Pin: ${cell.ir_sensor_pin || 'N/A'}</small>
      <div class="sensor-status ${cell.sensor_status === 'ACTIVE' ? 'active' : 'inactive'}"></div>
    `;
    body.appendChild(sensorIndicator);

    const irBadge = document.createElement("div");
    irBadge.className = "ir-reserved-badge";
    irBadge.textContent = "reserved";

    cellElement.appendChild(header);
    cellElement.appendChild(body);
    cellElement.appendChild(irBadge);

    cellElement.addEventListener("click", () => handleCellClick(cell));
    elements.cellsGrid.appendChild(cellElement);
  });

  if (state.sensorData?.cells) {
    updateCellOccupancyFromSensors(state.sensorData.cells);
  }
}

function renderLoadingZone() {
  // استخدم ID مباشر بدلاً من elements.loadingZone
  const loadingZoneElement = document.getElementById("loading-zone-cell");
  if (!loadingZoneElement) return;

  const loadingZoneContent = loadingZoneElement.querySelector('.cell-body');
  if (!loadingZoneContent) return;

  if (state.loadingZone && state.loadingZone.product_id) {
    const product = state.products.find(
      (p) => p.id === state.loadingZone.product_id
    );
    if (product) {
      loadingZoneContent.innerHTML = `
        <div class="cell-product-name">${product.name}</div>
        <div class="cell-qty">Qty: ${state.loadingZone.quantity}</div>
        ${product.sku ? `<div class="cell-sku">SKU: ${product.sku}</div>` : ""}
        <div class="loading-zone-sensors">
          <div class="sensor-info">
            <small>Ultrasonic: ${state.loadingZone.ultrasonic_distance || '--'} cm</small>
          </div>
          <div class="sensor-info">
            <small>Servo: ${state.loadingZone.servo_position || 90}°</small>
          </div>
        </div>
      `;
    } else {
      loadingZoneContent.innerHTML = `
        <div class="cell-product-name">Unknown Product</div>
        <div class="cell-qty">Qty: ${state.loadingZone.quantity}</div>
        <div class="loading-zone-sensors">
          <small>Ultrasonic Sensor Active</small>
        </div>
      `;
    }
    
    if (elements.loadingStatus) elements.loadingStatus.textContent = "Occupied";
    if (loadingZoneElement) loadingZoneElement.classList.add("occupied");
  } else {
    loadingZoneContent.innerHTML = `
      <div class="cell-empty">Empty</div>
      <div class="loading-zone-sensors">
        <div class="sensor-info">
          <small>Ultrasonic: Active</small>
        </div>
        <div class="sensor-info">
          <small>Servo: ${state.loadingZone?.servo_position || 90}°</small>
        </div>
      </div>
    `;
    
    if (elements.loadingStatus) elements.loadingStatus.textContent = "Empty";
    if (loadingZoneElement) loadingZoneElement.classList.remove("occupied");
  }
}

function renderProducts() {
  const productSelect = document.getElementById("product-select");
  const taskProductSelect = document.getElementById("task-product");

  if (productSelect) {
    productSelect.innerHTML = '<option value="">Select Product</option>';
    state.products.forEach((product) => {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = `${product.name} (RFID: ${product.rfid_uid || 'N/A'})`;
      productSelect.appendChild(option);
    });
  }

  if (taskProductSelect) {
    taskProductSelect.innerHTML = '<option value="">Select Product</option>';
    state.products.forEach((product) => {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = `${product.name} (RFID: ${product.rfid_uid || 'N/A'})`;
      taskProductSelect.appendChild(option);
    });
  }
}
function renderOperations() {
  const tbody = document.querySelector("#ops-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  state.operations.forEach((op) => {
    const row = document.createElement("tr");
    row.className = `status-${op.status.toLowerCase()}`;

    const time = new Date(op.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });

    row.innerHTML = `
      <td>${op.id}</td>
      <td>${op.op_type}</td>
      <td><code>${op.cmd}</code></td>
      <td><span class="badge badge-${getStatusColor(op.status)}">${op.status}</span></td>
      <td>${op.cell_label || "-"}</td>
      <td>${op.product_name || "-"}</td>
      <td>${time}</td>
    `;

    tbody.appendChild(row);
  });
}

function renderAutoTasks() {
  if (!elements.taskQueue) return;
  elements.taskQueue.innerHTML = "";

  if (state.autoTasks.length === 0) {
    elements.taskQueue.innerHTML =
      '<div class="task-item empty-queue">No tasks in queue</div>';
    return;
  }

  state.autoTasks.forEach((task) => {
    const taskElement = document.createElement("div");
    taskElement.className = "task-item";
    taskElement.dataset.taskId = task.id;
    
    const priorityClass = task.priority.toLowerCase();
    const statusClass = task.status.toLowerCase();
    
    taskElement.innerHTML = `
      <div>
        <div class="task-type">${task.task_type}</div>
        <div class="task-meta">
          ${task.cell_label ? `Cell: ${task.cell_label}` : ''}
          ${task.product_name ? ` | Product: ${task.product_name}` : ''}
          ${task.storage_strategy ? ` | Strategy: ${task.storage_strategy}` : ''}
        </div>
      </div>
      <div>
        <span class="task-priority ${priorityClass}">${task.priority}</span>
        <span class="task-status ${statusClass}">${task.status}</span>
      </div>
    `;
    
    elements.taskQueue.appendChild(taskElement);
  });
}

function updateStats() {
  const total = state.cells.length;
  const occupied = state.cells.filter((cell) => cell.display_status === 'OCCUPIED').length;
  const available = total - occupied;

  if (elements.totalCells) elements.totalCells.textContent = total;
  if (elements.occupiedCells) elements.occupiedCells.textContent = occupied;
  if (elements.availableCells) elements.availableCells.textContent = available;
}

function updateCellSelects() {
  const selects = ["cell-select", "move-cell-select", "task-cell"];

  selects.forEach((selectId) => {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    select.innerHTML = '<option value="">Select Cell</option>';

    state.cells.forEach((cell) => {
      const option = document.createElement("option");
      option.value = cell.id;
      let status = cell.display_status === 'OCCUPIED' ? " (Occupied)" : " (Empty)";
      option.textContent = `${cell.label} - R${cell.row_num}C${cell.col_num}${status}`;
      select.appendChild(option);
    });
  });
}
function updateProductSelects() {
  const selects = ["product-select", "task-product"];

  selects.forEach((selectId) => {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    select.innerHTML = '<option value="">Select Product</option>';

    state.products.forEach((product) => {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = `${product.name} (RFID: ${product.rfid_uid || 'N/A'})`;
      select.appendChild(option);
    });
  });
}

function updateSystemInfo(statusData) {
  if (!statusData) return;
  
  const irSensorCount = document.getElementById("ir-sensor-count");
  if (irSensorCount) {
    irSensorCount.textContent = statusData.cells?.ir_sensors_active || 12;
  }
  
  const loadingZoneInfo = document.getElementById("loading-zone-info");
  if (loadingZoneInfo) {
    const lzStatus = statusData.loading_zone?.status || 'EMPTY';
    loadingZoneInfo.textContent = `Status: ${lzStatus}, Sensors: Active`;
  }
  
  const conveyorInfo = document.getElementById("conveyor-info");
  if (conveyorInfo) {
    const mode = statusData.conveyor?.mode || 'MANUAL';
    const state = statusData.conveyor?.state || 'IDLE';
    conveyorInfo.textContent = `Mode: ${mode}, State: ${state}`;
  }
}

// ========== ENHANCED TASK HANDLERS ==========
async function setupEnhancedTaskHandlers() {
  // Disabled tasks (REORGANIZE / LOAD_RETURN) removed in final version

  // Stock quantity from conveyor
  const btnStockQuantity = document.getElementById('btn-stock-quantity');
  if (btnStockQuantity) {
    btnStockQuantity.addEventListener('click', async () => {
      const quantity = parseInt(prompt("How many items do you want to stock from the conveyor?", "1"), 10) || 1;
      const rfid = prompt("Product RFID (optional):", "");

      if (quantity <= 0) {
        showNotification("Please enter a valid quantity.", "warning");
        return;
      }

      try {
        await apiCall('/api/enhanced-tasks', 'POST', {
          task_type: 'STOCK_FROM_CONVEYOR',
          target_quantity: quantity,
          product_rfid: rfid || null,
          priority: 'MEDIUM'
        });
        showNotification(`Stock task added for ${quantity} item(s).`, "success");
        await loadWarehouseData();
      } catch (error) {
        showNotification("Failed to add the task.", "error");
      }
    });
  }

  // Move from cell to loading zone
  const btnCellToLoading = document.getElementById('btn-cell-to-loading');
  if (btnCellToLoading) {
    btnCellToLoading.addEventListener('click', async () => {
      const cellId = document.getElementById('move-cell-select')?.value;
      if (!cellId) {
        showNotification("Please select a cell.", "warning");
        return;
      }

      try {
        await apiCall('/api/enhanced-tasks', 'POST', {
          task_type: 'MOVE_TO_LOADING',
          cell_id: parseInt(cellId, 10),
          quantity: 1,
          priority: 'MEDIUM'
        });
        showNotification("Move to Loading Zone task added.", "success");
        await loadWarehouseData();
      } catch (error) {
        showNotification("Failed to add the task.", "error");
      }
    });
  }

}
// ========== SENSOR UPDATES ==========
function updateSensors(data) {
  if (!data) return;

  // Update LDR sensors
  if (data.ldr1 !== undefined) {
    state.sensorData.ldr1 = data.ldr1;
    const ldr1Light = elements.ldr1Indicator?.querySelector(".ldr-light");
    if (ldr1Light) ldr1Light.classList.toggle("active", !!data.ldr1);
  }

  if (data.ldr2 !== undefined) {
    state.sensorData.ldr2 = data.ldr2;
    const ldr2Light = elements.ldr2Indicator?.querySelector(".ldr-light");
    if (ldr2Light) ldr2Light.classList.toggle("active", !!data.ldr2);
  }

  // Update conveyor
  if (elements.conveyor) {
    const hasRealProduct = state.sensorData.ldr1 || state.sensorData.ldr2;
    elements.conveyor.classList.toggle("product-detected", hasRealProduct);
    
    const conveyorProduct = document.getElementById("conveyor-product");
    if (conveyorProduct) {
      if (hasRealProduct) {
        conveyorProduct.textContent = "Product Detected";
        conveyorProduct.classList.add("has-product");
      } else {
        conveyorProduct.textContent = "Empty";
        conveyorProduct.classList.remove("has-product");
      }
    }
  }

  // Update conveyor state
  if (data.conveyorState) {
    state.sensorData.conveyorState = data.conveyorState;
    const hasProductOnConveyor = state.sensorData.ldr1 || state.sensorData.ldr2;
    
    if (elements.conveyorStatus) {
      elements.conveyorStatus.textContent = `Conveyor: ${data.conveyorState}`;
      
      switch (data.conveyorState) {
        case "IDLE":
          elements.conveyorStatus.className = "badge badge-gray";
          break;
        case "MOVE_12CM":
        case "MOVING_TO_LDR2":
          elements.conveyorStatus.className = hasProductOnConveyor ? "badge badge-yellow" : "badge badge-gray";
          break;
        case "WAIT_RFID":
          elements.conveyorStatus.className = "badge badge-blue";
          break;
        case "STOPPED":
          elements.conveyorStatus.className = "badge badge-red";
          break;
        case "MANUAL_MODE":
          elements.conveyorStatus.className = "badge badge-purple";
          break;
        default:
          elements.conveyorStatus.className = "badge badge-gray";
      }
    }
  }

  // Update RFID
  if (data.rfid !== undefined) {
    state.sensorData.rfid = data.rfid;
    if (elements.rfidTag) elements.rfidTag.textContent = data.rfid || "None";
    if (elements.currentRfid) elements.currentRfid.textContent = data.rfid || "None";
  }

  // Update current operation (used to detect STOCK_QTY_DONE)
  if (data.currentOperation !== undefined) {
    state.sensorData.currentOperation = data.currentOperation || "";
  }

  // Update current operation / arm status (for progress + completion)
  if (data.currentOperation !== undefined) {
    state.sensorData.currentOperation = data.currentOperation || "";
  }
  if (data.armStatus !== undefined) {
    state.sensorData.armStatus = data.armStatus || "";
  }

  // Manual Auto-Stock completion: close overlay on DONE / timeout
  if (pendingManualAutoStock.awaitingDone) {
    const op = String(state.sensorData.currentOperation || "");
    const done = op.includes("STOCK_QTY_DONE") || op.includes("STOCK_DONE");
    const timedOut = pendingManualAutoStock.startedAt && (Date.now() - pendingManualAutoStock.startedAt > 180000);
    if (done || timedOut) {
      pendingManualAutoStock.awaitingDone = false;
      pendingManualAutoStock.running = false;
      hideLoadingOverlay();
      if (done) showNotification("Auto stock completed.", "success");
      else showNotification("Auto stock timed out.", "warning");
      loadWarehouseData();
    }
  }

  // Update current operation / arm status (for progress + completion)
  if (data.currentOperation !== undefined) {
    state.sensorData.currentOperation = data.currentOperation || "";
  }
  if (data.armStatus !== undefined) {
    state.sensorData.armStatus = data.armStatus || "";
  }

  // Manual Auto-Stock completion: close overlay on DONE / timeout
  if (pendingManualAutoStock.awaitingDone) {
    const op = String(state.sensorData.currentOperation || "");
    const done = op.includes("STOCK_QTY_DONE") || op.includes("STOCK_DONE");
    const timedOut = pendingManualAutoStock.startedAt && (Date.now() - pendingManualAutoStock.startedAt > 180000);
    if (done || timedOut) {
      pendingManualAutoStock.awaitingDone = false;
      pendingManualAutoStock.running = false;
      hideLoadingOverlay();
      if (done) showNotification("Auto stock completed.", "success");
      else showNotification("Auto stock timed out.", "warning");
      loadWarehouseData();
    }
  }


  // Update current operation / arm status (for progress + completion)
  if (data.currentOperation !== undefined) {
    state.sensorData.currentOperation = data.currentOperation || "";
  }
  if (data.armStatus !== undefined) {
    state.sensorData.armStatus = data.armStatus || "";
  }

  // Manual Auto-Stock completion: close overlay on DONE or timeout
  if (pendingManualAutoStock.awaitingDone) {
    const op = String(state.sensorData.currentOperation || "");
    const done = op.includes("STOCK_QTY_DONE") || op.includes("STOCK_DONE");
    const timedOut = pendingManualAutoStock.startedAt && (Date.now() - pendingManualAutoStock.startedAt > 180000);
    if (done || timedOut) {
      pendingManualAutoStock.awaitingDone = false;
      pendingManualAutoStock.running = false;
      hideLoadingOverlay();
      if (done) showNotification("Auto stock completed.", "success");
      else showNotification("Auto stock timed out.", "warning");
      loadWarehouseData();
    }
  }

  // Update current operation / arm status (for progress + completion)
  if (data.currentOperation !== undefined) {
    state.sensorData.currentOperation = data.currentOperation || "";
  }
  if (data.armStatus !== undefined) {
    state.sensorData.armStatus = data.armStatus || "";
  }

  // Manual Auto-Stock completion: close overlay when DONE is reported
  if (pendingManualAutoStock.awaitingDone) {
    const op = String(state.sensorData.currentOperation || "");
    const done = op.includes("STOCK_QTY_DONE") || op.includes("STOCK_DONE");
    const timedOut = pendingManualAutoStock.startedAt && (Date.now() - pendingManualAutoStock.startedAt > 180000);
    if (done || timedOut) {
      pendingManualAutoStock.awaitingDone = false;
      pendingManualAutoStock.running = false;
      hideLoadingOverlay();
      if (done) showNotification("Auto stock completed.", "success");
      else showNotification("Auto stock timed out.", "warning");
      loadWarehouseData();
    }
  }

  // Update current operation / arm status (for progress + completion)
  if (data.currentOperation !== undefined) {
    state.sensorData.currentOperation = data.currentOperation || "";
  }
  if (data.armStatus !== undefined) {
    state.sensorData.armStatus = data.armStatus || "";
  }

  // If a manual auto-stock cycle is running, close overlay when DONE is reported
  if (pendingManualAutoStock.awaitingDone) {
    const op = String(state.sensorData.currentOperation || "");
    if (op.includes("STOCK_QTY_DONE")) {
      pendingManualAutoStock.awaitingDone = false;
      pendingManualAutoStock.running = false;
      hideLoadingOverlay();
      showNotification("Auto stock cycle completed.", "success");
      loadWarehouseData().catch(() => {});
    } else {
      const now = Date.now();
      if (pendingManualAutoStock.startedAt && (now - pendingManualAutoStock.startedAt) > 180000) {
        pendingManualAutoStock.awaitingDone = false;
        pendingManualAutoStock.running = false;
        hideLoadingOverlay();
        showNotification("Auto stock cycle timeout. Check Mega/ESP telemetry.", "warning");
      }
    }
  }


  // Update loading zone
  if (data.loadingZoneOccupied !== undefined) {
    state.sensorData.loadingZoneOccupied = data.loadingZoneOccupied;
    updateLoadingZoneVisual(data.loadingZoneOccupied);
  }

  // Update storage strategy
  if (data.storageStrategy && data.storageStrategy !== state.storageStrategy) {
    state.storageStrategy = data.storageStrategy;
    updateStorageStrategyUI(data.storageStrategy);
  }

  // Update IR cells
  if (data.cells && Array.isArray(data.cells)) {
    updateCellOccupancyFromSensors(data.cells);
  }

  // If user requested Manual Auto-Stock, keep the overlay in-sync with telemetry/state
  updateManualAutoStockOverlayFromTelemetry();
}

function updateManualAutoStockOverlayFromTelemetry() {
  if (!pendingManualAutoStock.awaitingDone) return;

  const op = String(state.sensorData?.currentOperation || state.currentOperation || "");
  const conv = String(state.sensorData?.conveyorState || "");

  // Update the overlay text live
  const step = conv ? conv.replace(/_/g, " ") : (op || "Working...");
  if (elements.currentStep) elements.currentStep.textContent = step;
  if (elements.loadingMessage) {
    // Prefer explicit operation messages (AUTO_STOCK_START/COMPLETE/STATE:...)
    elements.loadingMessage.textContent = op ? op.replace(/_/g, " ") : `Conveyor: ${step}`;
  }

  // Consider it done when Mega reports completion markers
  const done =
    op.startsWith("AUTO_STOCK_COMPLETE") ||
    op === "AUTO_ONESHOT_DONE" ||
    op.startsWith("STOCK_QTY_COMPLETE") ||
    op === "STOCK_QTY_DONE";

  if (done) {
    pendingManualAutoStock.awaitingDone = false;
    pendingManualAutoStock.running = false;
    hideLoadingOverlay();
    showNotification("Auto stock cycle completed.", "success");
    loadWarehouseData().catch(() => {});
  }
}

function showLoadingOverlay(title, message) {
  if (!elements.loadingOverlay) return;
  if (elements.loadingTitle) elements.loadingTitle.textContent = title || "Working...";
  if (elements.loadingMessage) elements.loadingMessage.textContent = message || "";
  elements.loadingOverlay.classList.add("active");
}

function hideLoadingOverlay() {
  elements.loadingOverlay?.classList.remove("active");
}

async function startManualAutoStockRun() {
  if (pendingManualAutoStock.running) return;
  pendingManualAutoStock.running = true;
  pendingManualAutoStock.waiting = false;

  const strategy = pendingManualAutoStock.strategy || "NEAREST_EMPTY";
  showLoadingOverlay(
    "Auto Stock From Conveyor",
    `Running stock cycle using strategy: ${strategy} ...`
  );

  try {
    await apiCall("/api/manual/stock-from-conveyor", "POST", { strategy });
    // Don't close the overlay here. We keep it until we receive completion markers over WS.
    pendingManualAutoStock.awaitingDone = true;
    pendingManualAutoStock.startedAt = Date.now();
    showNotification("Auto stock started. Waiting for Mega to finish...", "success");
  } catch (err) {
    console.error("Manual auto-stock failed:", err);
    showNotification("Failed to run auto stock cycle.", "error");
    hideLoadingOverlay();
  } finally {
    pendingManualAutoStock.running = false;
  }
}

function updateCellOccupancyFromSensors(cellData) {
  if (!Array.isArray(cellData) || cellData.length !== 3) return;
  state.sensorData.cells = cellData;

  if (!state.irMemory) {
    state.irMemory = Array.from({ length: 3 }, () =>
      Array.from({ length: 4 }, () => ({
        occupied: false,
        lastRaw: null,
        confirm: 0,
        lastTrueAt: 0
      }))
    );
  }

  const CONFIRM_N = 3;
  const HOLD_MS = 4000;
  let irOccupiedCount = 0;

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let rawOcc = !!(cellData[r] && cellData[r][c]);
      const mem = state.irMemory[r][c];

      const now = Date.now();
      if (rawOcc) mem.lastTrueAt = now;
      if (!rawOcc && mem.lastTrueAt && (now - mem.lastTrueAt) <= HOLD_MS) {
        rawOcc = true;
      }

      if (mem.lastRaw === null) {
        mem.lastRaw = rawOcc;
        mem.occupied = rawOcc;
        mem.confirm = 0;
      } else {
        if (rawOcc !== mem.lastRaw) {
          mem.lastRaw = rawOcc;
          mem.confirm = 1;
        } else {
          if (mem.occupied !== rawOcc) {
            mem.confirm++;
            if (mem.confirm >= CONFIRM_N) {
              mem.occupied = rawOcc;
              mem.confirm = 0;
            }
          } else {
            mem.confirm = 0;
          }
        }
      }

      const isIrOccupied = mem.occupied;
      if (isIrOccupied) irOccupiedCount++;

      const el = document.querySelector(`.cell[data-row="${r + 1}"][data-col="${c + 1}"]`);
      if (!el) continue;

      el.classList.toggle("ir-occupied", isIrOccupied);
      el.classList.toggle("ir-empty", !isIrOccupied);

      const irBadge = el.querySelector(".ir-reserved-badge");
      if (irBadge) {
        if (isIrOccupied) {
          irBadge.style.display = "inline-flex";
          irBadge.textContent = "RESERVED";
          irBadge.style.backgroundColor = "rgba(34, 197, 94, 0.25)";
        } else {
          irBadge.style.display = "none";
        }
      }

      el.dataset.irOccupied = isIrOccupied ? "1" : "0";
      const hasStoredProduct = el.classList.contains("occupied");
      el.classList.toggle("ir-confirmed", hasStoredProduct && isIrOccupied);
    }
  }

  const activeSensorsElement = document.getElementById("active-sensors");
  if (activeSensorsElement) activeSensorsElement.textContent = `${irOccupiedCount}/12`;

  const activeSensorCountElement = document.getElementById("active-sensor-count");
  if (activeSensorCountElement) activeSensorCountElement.textContent = irOccupiedCount;

  const occupiedSensorCountElement = document.getElementById("occupied-sensor-count");
  if (occupiedSensorCountElement) occupiedSensorCountElement.textContent = irOccupiedCount;

  const sensorUpdateTimeElement = document.getElementById("sensor-update-time");
  if (sensorUpdateTimeElement) sensorUpdateTimeElement.textContent = new Date().toLocaleTimeString();
}

function resetIRMemoryForCell(row, col) {
  if (!state.irMemory) return;
  const r = parseInt(row, 10) - 1;
  const c = parseInt(col, 10) - 1;
  if (r < 0 || r >= 3 || c < 0 || c >= 4) return;

  state.irMemory[r][c] = { occupied: false, lastRaw: null, confirm: 0 };

  const el = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
  if (el) {
    el.classList.remove("ir-occupied", "ir-confirmed");
    el.classList.add("ir-empty");
    const irBadge = el.querySelector(".ir-reserved-badge");
    if (irBadge) irBadge.style.display = "none";
    el.dataset.irOccupied = "0";
  }
}

// ========== LOADING ZONE VISUAL ==========
function updateLoadingZoneVisual(occupied) {
  const statusLabel = document.getElementById("loading-zone-status");
  if (statusLabel) statusLabel.textContent = occupied ? "OCCUPIED" : "EMPTY";

  if (elements.loadingZoneElement) {
    elements.loadingZoneElement.classList.toggle("occupied", !!occupied);
  }

  if (elements.loadingStatus) {
    elements.loadingStatus.textContent = occupied ? "Occupied" : "Empty";
  }
}

// ========== CONVEYOR UI ==========
function updateConveyorUI(product, hasProduct) {
  state.conveyor = product;
  if (!elements.conveyorProduct) return;

  const shouldShowProduct = hasProduct !== undefined ? hasProduct : (product && product.has_product);
  
  if (shouldShowProduct) {
    elements.conveyorProduct.textContent = product?.product_name || "Product Detected";
    elements.conveyorProduct.classList.add("has-product");
    if (elements.conveyor) elements.conveyor.classList.add("product-detected");
  } else {
    elements.conveyorProduct.textContent = "Empty";
    elements.conveyorProduct.classList.remove("has-product");
    if (elements.conveyor) elements.conveyor.classList.remove("product-detected");
  }
}

// ========== RFID UPDATE ==========
function updateRFID(tag, symbol, product, targetCell) {
  if (!tag) return;

  const label = symbol ? `${symbol} (${tag})` : tag;
  if (elements.rfidTag) elements.rfidTag.textContent = label;
  if (elements.currentRfid) elements.currentRfid.textContent = label;

  if (targetCell && targetCell.row && targetCell.col) {
    const cellLabel = `R${targetCell.row}C${targetCell.col}`;
    if (elements.targetCell) elements.targetCell.textContent = cellLabel;
    highlightTargetCell(targetCell.row, targetCell.col);
  }
}

function highlightTargetCell(row, col) {
  document.querySelectorAll(".cell").forEach((cell) => {
    cell.classList.remove("target-cell");
    cell.style.borderColor = "";
    cell.style.boxShadow = "";
  });

  const targetCellElement = document.querySelector(
    `.cell[data-row="${row}"][data-col="${col}"]`
  );
  
  if (targetCellElement) {
    targetCellElement.classList.add("target-cell");
    targetCellElement.style.borderColor = "#f59e0b";
    targetCellElement.style.boxShadow = "0 0 10px rgba(245, 158, 11, 0.5)";

    setTimeout(() => {
      targetCellElement.classList.remove("target-cell");
      targetCellElement.style.borderColor = "";
      targetCellElement.style.boxShadow = "";
    }, 5000);
  }
}

// ========== OPERATIONS ==========
async function sendOperation(type, command, options = {}) {
  if (state.isLoading) {
    showNotification("Please wait for current operation to complete", "warning");
    return;
  }

  const directCommands = [
    "CONVEYOR_MOVE", "CONVEYOR_STOP", 
    "LOADING_", "CHECK_LOADING",
    "STRATEGY", "GET_IR_STATUS", "GET_LOADING_STATUS"
  ];
  
  const isDirectCommand = directCommands.some(cmd => command.startsWith(cmd));
  
  if (isDirectCommand) {
    try {
      await apiCall("/api/operations", "POST", {
        op_type: 'MANUAL_CMD',
        cmd: command,
        priority: 'MEDIUM'
      });
      showNotification("Command sent to ESP32", "success");
    } catch (error) {
      showNotification("Failed to send command", "error");
    }
    return;
  }

  const hideLoader = showLoading(
    "Executing Command",
    `Sending command: ${command}`,
    estimateOperationTime(type)
  );

  try {
    if (elements.currentStep) elements.currentStep.textContent = "Sending to ESP32...";

    const result = await apiCall("/api/operations", "POST", {
      op_type: type,
      cmd: command,
      product_id: options.product_id || null,
      cell_id: options.cell_id || null,
      priority: options.priority || 'MEDIUM'
    });

    if (elements.currentStep) elements.currentStep.textContent = "Waiting for completion...";

    if (!result.success) {
      hideLoader();
      showNotification(`Operation failed: ${result.error}`, "error");
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    await loadWarehouseData();

    hideLoader();
    showNotification("Operation completed successfully", "success");
  } catch (error) {
    hideLoader();
    console.error("Operation failed:", error);
    showNotification("Operation failed to execute", "error");
  }
}

function estimateOperationTime(type) {
  const times = {
    HOME: 5,
    PICK_FROM_CONVEYOR: 8,
    PLACE_IN_CELL: 8,
    TAKE_FROM_CELL: 8,
    GOTO_COLUMN: 5,
    MOVE_TO_LOADING: 10,
    RETURN_TO_LOADING: 10,
    AUTO_STOCK: 15,
    LOADING_ZONE_OPERATION: 3,
    CONVEYOR_MANUAL: 2
  };
  return times[type] || 6;
}

// ========== LOADING OVERLAY ==========
function showLoading(title, message, estimatedTime = 5) {
  state.isLoading = true;
  elements.loadingTitle.textContent = title;
  elements.loadingMessage.textContent = message;
  elements.estimatedTime.textContent = `${estimatedTime}s`;
  elements.progressBar.style.width = "0%";
  elements.loadingOverlay.classList.add("active");

  let progress = 0;
  const interval = setInterval(() => {
    progress += 100 / (estimatedTime * 10);
    if (progress >= 100) {
      clearInterval(interval);
      progress = 100;
    }
    elements.progressBar.style.width = `${progress}%`;
  }, 100);

  return () => {
    clearInterval(interval);
    hideLoading();
  };
}

function hideLoading() {
  state.isLoading = false;
  elements.loadingOverlay.classList.remove("active");
  setTimeout(() => {
    elements.progressBar.style.width = "0%";
  }, 300);
}

// ========== MODE CONTROL ==========
// ========== AUTO MODE CONTROL ==========
async function startAutoMode() {
  try {
    // 1) خلي المود AUTO (بدون تشغيل تنفيذ الكيو)
    await apiCall("/api/mode", "POST", { mode: "auto" });

    // 2) شغّل التنفيذ الفعلي (AUTO START + تشغيل الـ processor)
    const res = await apiCall("/api/auto/start", "POST", {});
    if (!res.success) {
      showNotification(`Failed to start auto: ${res.error}`, "error");
    } else {
      applyModeUI("auto");
      showNotification("Auto Mode started", "success");

      await loadWarehouseData();
    }
  } catch (err) {
    console.error("startAutoMode error:", err);
    showNotification("Failed to start auto mode", "error");
  }
}

async function stopAutoMode() {
  try {
    // 1) أوقف التنفيذ (AUTO STOP + إيقاف الـ processor)
    const res = await apiCall("/api/auto/stop", "POST", {});
    if (!res.success) {
      showNotification(`Failed to stop auto: ${res.error}`, "error");
    } else {
      applyModeUI("manual");
      showNotification("Auto Mode stopped", "info");

      // 2) رجّع المود MANUAL
      await apiCall("/api/mode", "POST", { mode: "manual" });
    }
  } catch (err) {
    console.error("stopAutoMode error:", err);
    showNotification("Failed to stop auto mode", "error");
  }
}

// ========== CELL CLICK HANDLER ==========
function handleCellClick(cell) {
  document.querySelectorAll(".cell.selected").forEach((el) => {
    el.classList.remove("selected");
  });

  const cellElement = document.querySelector(`[data-cell-id="${cell.id}"]`);
  if (cellElement) cellElement.classList.add("selected");

  const colInput = document.getElementById("place-col");
  const rowInput = document.getElementById("place-row");
  const pickColInput = document.getElementById("pick-col");
  const pickRowInput = document.getElementById("pick-row");
  const cellSelect = document.getElementById("cell-select");
  const moveCellSelect = document.getElementById("move-cell-select");

  if (colInput) colInput.value = cell.col_num;
  if (rowInput) rowInput.value = cell.row_num;
  if (pickColInput) pickColInput.value = cell.col_num;
  if (pickRowInput) pickRowInput.value = cell.row_num;
  if (cellSelect) cellSelect.value = cell.id;
  if (moveCellSelect) moveCellSelect.value = cell.id;

  showNotification(`Selected ${cell.label}`, "info");
}

// ========== UPDATE FUNCTIONS ==========
function updateWarehouseData(data) {
  if (data.cells) {
    state.cells = data.cells;
    renderCells();
    updateStats();
  }
  if (data.loadingZone) {
    state.loadingZone = data.loadingZone;
    renderLoadingZone();
  }
  if (data.conveyor) {
    state.conveyor = data.conveyor;
    updateConveyorUI(data.conveyor);
  }
  if (data.systemSettings) {
    updateSystemSettings(data.systemSettings);
  }
}

function updateOperationStatus(operation) {
  if (!operation) return;
  
  const rows = document.querySelectorAll("#ops-table tbody tr");
  rows.forEach((row) => {
    if (row.cells[0].textContent == operation.id) {
      row.cells[3].innerHTML = `<span class="badge badge-${getStatusColor(operation.status)}">${operation.status}</span>`;
      row.className = `status-${operation.status.toLowerCase()}`;
    }
  });
}

function updateCell(cell) {
  if (!cell) return;

  const index = state.cells.findIndex((c) => c.id === cell.id);
  if (index !== -1) {
    state.cells[index] = cell;

    const ds = (cell.display_status || cell.status || "");
    if (ds === "EMPTY") {
      resetIRMemoryForCell(cell.row_num, cell.col_num);
    }

    renderCells();
    updateStats();
    updateCellSelects();
  }
}


function updateAutoTask(task) {
  if (!task) return;
  
  const index = state.autoTasks.findIndex((t) => t.id === task.id);
  if (index !== -1) {
    state.autoTasks[index] = task;
  } else {
    state.autoTasks.push(task);
  }
  
  renderAutoTasks();
}

// ========== STORAGE STRATEGY ==========
async function setStorageStrategy(strategy) {
  try {
    const result = await apiCall("/api/storage-strategy", "POST", {
      strategy: strategy
    });
    
    if (result.success) {
      state.storageStrategy = strategy;
      updateStorageStrategyUI(strategy);
      showNotification(`Storage strategy set to ${strategy}`, "success");
    }
  } catch (error) {
    console.error("Error setting storage strategy:", error);
    showNotification("Failed to set storage strategy", "error");
  }
}

// ========== CONVEYOR CONTROL ==========
async function controlConveyor(action) {
  try {
    const result = await apiCall("/api/conveyor/manual", "POST", {
      action: action
    });
    
    if (result.success) {
      showNotification(`Conveyor ${action} command sent`, "success");
    }
  } catch (error) {
    console.error("Error controlling conveyor:", error);
    showNotification("Failed to control conveyor", "error");
  }
}

// ========== LOADING ZONE CONTROL ==========
async function controlLoadingZone(action) {
  try {
    const result = await apiCall("/api/loading-zone/control", "POST", {
      action: action
    });
    
    if (result.success) {
      showNotification(`Loading zone ${action} command sent`, "success");
    }
  } catch (error) {
    console.error("Error controlling loading zone:", error);
    showNotification("Failed to control loading zone", "error");
  }
}

// ========== AUTO TASK MANAGEMENT ==========
async function addAutoTask(taskData) {
  try {
    const result = await apiCall("/api/enhanced-tasks", "POST", taskData);

    if (result.success) {
      showNotification("Task added to queue", "success");
      await loadWarehouseData();
    } else {
      throw new Error(result.error || "Unknown error");
    }
  } catch (error) {
    console.error("Error adding auto task:", error);
    showNotification("Failed to add task", "error");
    throw error;
  }
}

// ========== PRODUCT MANAGEMENT ==========
async function addProduct() {
  const name = document.getElementById("prod-name")?.value.trim();
  const sku = document.getElementById("prod-sku")?.value.trim();
  const rfid = document.getElementById("prod-rfid")?.value.trim();

  if (!name) {
    showNotification("Product name is required", "error");
    return;
  }

  try {
    await apiCall("/api/products", "POST", {
      name,
      sku: sku || null,
      rfid_uid: rfid || null
    });

    showNotification("Product added successfully", "success");

    const prodNameInput = document.getElementById("prod-name");
    const prodSkuInput = document.getElementById("prod-sku");
    const prodRfidInput = document.getElementById("prod-rfid");
    
    if (prodNameInput) prodNameInput.value = "";
    if (prodSkuInput) prodSkuInput.value = "";
    if (prodRfidInput) prodRfidInput.value = "";

    await loadWarehouseData();
  } catch (error) {
    showNotification("Failed to add product", "error");
  }
}

async function assignProduct() {
  const cellId = document.getElementById("cell-select")?.value;
  const productId = document.getElementById("product-select")?.value;
  const qtyInput = document.getElementById("product-qty");
  const qty = qtyInput ? parseInt(qtyInput.value, 10) || 1 : 1;

  if (!cellId || !productId) {
    showNotification("Please select both cell and product", "warning");
    return;
  }

  try {
    await apiCall(`/api/cells/${cellId}/assign`, "POST", {
      product_id: productId,
      quantity: qty
    });

    showNotification("Product assigned successfully", "success");
    await loadWarehouseData();
  } catch (error) {
    showNotification("Failed to assign product", "error");
  }
}

async function moveToLoading() {
  const cellId = document.getElementById("move-cell-select")?.value;

  if (!cellId) {
    showNotification("Please select a cell", "warning");
    return;
  }

  const cell = state.cells.find((c) => c.id == cellId);
  if (!cell || !cell.product_id) {
    showNotification("Selected cell is empty", "warning");
    return;
  }

  sendOperation(
    "MOVE_TO_LOADING",
    `LOADING_TAKE ${cell.col_num} ${cell.row_num}`,
    {
      cell_id: cellId,
      product_id: cell.product_id
    }
  );
}

// ========== EVENT HANDLERS SETUP ==========
function setupEventHandlers() {
  // Mode switch
  if (elements.modeSelect) {
    elements.modeSelect.addEventListener("change", async (e) => {
      const mode = e.target.value;
      if (mode === "auto") await startAutoMode();
      else await stopAutoMode();
    });
  }

  // Storage strategy
  const strategySelect = document.getElementById("strategy-select");
  if (strategySelect) {
    strategySelect.addEventListener("change", async (e) => {
      const strategy = e.target.value;
      await setStorageStrategy(strategy);
    });
  }

  // Manual control buttons
  setupManualControls();
  setupAutoControls();
  setupProductManagement();
  setupTaskManagement();
  setupLoadingZoneControls();
  setupLoadingModalHandlers();
  setupConveyorControls();
  setupStrategyButtons();
  setupSensorTestButtons();
}

// ========== LOADING MODAL (manual place/take) ==========
function setupLoadingModalHandlers() {
  // Modal close/cancel
  document.getElementById("loading-modal-close")?.addEventListener("click", () => {
    elements.loadingModal?.classList.remove("active");
  });
  document.getElementById("btn-cancel-loading")?.addEventListener("click", () => {
    elements.loadingModal?.classList.remove("active");
  });

  elements.loadingAction?.addEventListener("change", () => {
    refreshLoadingModalOptions();
  });

  document.getElementById("btn-confirm-loading")?.addEventListener("click", () => {
    submitLoadingModal();
  });
}

function getCellByLabel(label) {
  return (state.cells || []).find(c => {
    const dbLabel = String(c.label || c.cell_label || "");
    const uiLabel = buildCellLabel(c.row_num, c.col_num);
    return dbLabel === label || uiLabel === label;
  }) || null;
}

function buildCellLabel(row, col) {
  if (row == null || col == null) return "Unknown Cell";
  return `R${row}C${col}`;
}

function refreshLoadingModalOptions() {
  if (!elements.loadingModal) return;

  const action = elements.loadingAction?.value || "place_to_loading";

  const sourceGroup = document.getElementById("loading-source-group");
  const targetGroup = document.getElementById("loading-target-group");
  const info = elements.loadingModalInfo;

  if (sourceGroup) sourceGroup.style.display = (action === "place_to_loading") ? "block" : "none";
  if (targetGroup) targetGroup.style.display = (action === "take_from_loading") ? "block" : "none";

const cells = Array.isArray(state.cells) ? state.cells : [];

const getStatus = (c) => String(c.display_status ?? c.status ?? "").toUpperCase();

const occupied = cells.filter(c =>
  getStatus(c) === "OCCUPIED" || Number(c.product_id) > 0
);

const empty = cells.filter(c =>
  getStatus(c) === "EMPTY" && !(Number(c.product_id) > 0)
);

  if (elements.loadingSourceCell) {
    elements.loadingSourceCell.innerHTML = "";
    occupied.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id || buildCellLabel(c.row_num, c.col_num);
      opt.textContent = c.label || c.cell_label || buildCellLabel(c.row_num, c.col_num);
      elements.loadingSourceCell.appendChild(opt);
    });
  }

  if (elements.loadingTargetCell) {
    elements.loadingTargetCell.innerHTML = "";
    empty.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id || buildCellLabel(c.row_num, c.col_num);
      opt.textContent = c.label || c.cell_label || buildCellLabel(c.row_num, c.col_num);
      elements.loadingTargetCell.appendChild(opt);
    });
  }

  // Info hint
  if (info) {
    const lzOcc = !!(state.loadingZone && (state.loadingZone.status || "").toUpperCase() === "OCCUPIED");
    if (action === "place_to_loading") {
      info.textContent = lzOcc ? "Loading zone is OCCUPIED. Place-to-loading will be denied." : "Pick from an OCCUPIED cell and place to loading zone.";
    } else {
      info.textContent = lzOcc ? "Take from loading zone and place into EMPTY cell." : "Loading zone is EMPTY. Take-from-loading will be denied.";
    }
  }
}

// Ensure we have a fresh cells list even if WebSocket hasn't delivered warehouse_data yet.
// This prevents Loading Zone modals from showing empty dropdowns.
async function ensureCellsLoaded() {
  if (Array.isArray(state.cells) && state.cells.length > 0) return;
  try {
    const res = await fetch("/api/cells");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cells = await res.json();
    if (Array.isArray(cells)) state.cells = cells;
  } catch (e) {
    console.error("ensureCellsLoaded failed:", e);
  }
}

async function openLoadingModal(defaultAction = "place_to_loading") {
  if (!elements.loadingModal) {
    showNotification("Loading modal not found in HTML", "error");
    return;
  }

  if (elements.loadingAction) elements.loadingAction.value = defaultAction;
  if (elements.loadingModalTitle) {
    elements.loadingModalTitle.textContent = (defaultAction === "place_to_loading")
      ? "Place to Loading"
      : "Take from Loading";
  }
  await ensureCellsLoaded();
  refreshLoadingModalOptions();
  elements.loadingModal.classList.add("active");
}

async function submitLoadingModal() {
  const action = elements.loadingAction?.value || "place_to_loading";

  const lzOcc = !!(state.loadingZone && (state.loadingZone.status || "").toUpperCase() === "OCCUPIED");

  if (action === "place_to_loading") {
  const lzOcc =
    !!state.sensorData.loadingZoneOccupied ||
    !!(state.loadingZone && String(state.loadingZone.status || "").toUpperCase() === "OCCUPIED");

  if (lzOcc) {
    showNotification("Loading zone is occupied. Empty it first.", "warning");
    return;
  }

  const selected = elements.loadingSourceCell?.options?.[elements.loadingSourceCell.selectedIndex]?.textContent;
  if (!selected) {
    showNotification("No source cell selected", "warning");
    return;
  }

  const cell = getCellByLabel(selected);

  const isOccupied = (c) => {
    if (!c) return false;
    if (c.product_id !== null && c.product_id !== undefined) return true;
    const s = String(c.display_status ?? c.status ?? "").toUpperCase();
    return s === "OCCUPIED";
  };

  if (!isOccupied(cell)) {
    showNotification("Selected source cell is not OCCUPIED", "error");
    return;
  }

  await sendOperation("LOADING_PLACE", `LOADING_PLACE ${cell.col_num} ${cell.row_num}`);
  elements.loadingModal?.classList.remove("active");
  return;
}


  // take_from_loading
  if (!lzOcc) {
    showNotification("Loading zone is empty.", "warning");
    return;
  }

  const targetSelected = elements.loadingTargetCell?.options?.[elements.loadingTargetCell.selectedIndex]?.textContent;
  if (!targetSelected) {
    showNotification("No target cell selected", "warning");
    return;
  }
  const tCell = getCellByLabel(targetSelected);
  if (!tCell || (tCell.status || "").toUpperCase() !== "EMPTY") {
    showNotification("Selected target cell is not EMPTY", "error");
    return;
  }

  await sendOperation("LOADING_TAKE", `LOADING_TAKE ${tCell.col_num} ${tCell.row_num}`);
  elements.loadingModal?.classList.remove("active");
}

function setupManualControls() {
  // ===== Manual: Stock From Conveyor (Auto stock cycle but triggered from Manual UI) =====
  const manualStockModal = document.getElementById("manual-stock-modal");
  const manualStockClose = document.getElementById("manual-stock-modal-close");
  const manualStockCancel = document.getElementById("btn-cancel-manual-stock");
  const manualStockConfirm = document.getElementById("btn-confirm-manual-stock");
  const manualStockStrategy = document.getElementById("manual-stock-strategy");

  const openManualStockModal = () => manualStockModal?.classList.add("active");
  const closeManualStockModal = () => manualStockModal?.classList.remove("active");

  manualStockClose?.addEventListener("click", closeManualStockModal);
  manualStockCancel?.addEventListener("click", closeManualStockModal);
  manualStockModal?.addEventListener("click", (e) => {
    if (e.target === manualStockModal) closeManualStockModal();
  });

  manualStockConfirm?.addEventListener("click", async () => {
    const strategy = (manualStockStrategy?.value || state.storageStrategy || "NEAREST_EMPTY").toUpperCase();

    // Start one-shot cycle on the Mega.
    // The Mega itself waits for LDR1, reads RFID, moves to LDR2, then picks & places by strategy.
    pendingManualAutoStock.strategy = strategy === "FIXED" ? "FIXED" : "NEAREST_EMPTY";
    pendingManualAutoStock.waiting = false;
    pendingManualAutoStock.running = false;
    pendingManualAutoStock.awaitingDone = false;

    closeManualStockModal();

    showLoadingOverlay(
      "Auto Stock From Conveyor",
      "Waiting for IR1 (LDR1) to detect a product..."
    );

    // Trigger immediately; Mega will wait for LDR1 internally.
    await startManualAutoStockRun();
  });

  const controls = {
    "btn-home": () => sendOperation("HOME", "HOME"),
    "btn-pick-conveyor": () => sendOperation("PICK_FROM_CONVEYOR", "PICK"),
    "btn-goto-column": () => {
      const col = document.getElementById("goto-column")?.value;
      if (col) sendOperation("GOTO_COLUMN", `GOTO ${col}`);
    },
    "btn-place": () => {
      const col = document.getElementById("place-col")?.value;
      const row = document.getElementById("place-row")?.value;
      if (col && row) sendOperation("PLACE_IN_CELL", `PLACE ${col} ${row}`);
    },
    "btn-pick-cell": () => {
      const col = document.getElementById("pick-col")?.value;
      const row = document.getElementById("pick-row")?.value;
      if (col && row) {
        sendOperation("TAKE_FROM_CELL", `TAKE ${col} ${row}`);
        resetIRMemoryForCell(row, col);
      }
    },
    "btn-loading-place": () => {
      openLoadingModal("place_to_loading");
    },
    "btn-loading-take": () => {
      openLoadingModal("take_from_loading");
    },
    "btn-manual-stock-from-conveyor": () => {
      // Required behavior: show popup (strategy), then wait for LDR1 trigger.
      // If already running/awaiting completion, clicking again cancels the UI overlay.
      if (pendingManualAutoStock.running || pendingManualAutoStock.awaitingDone) {
        pendingManualAutoStock.running = false;
        pendingManualAutoStock.awaitingDone = false;
        hideLoadingOverlay();
        showNotification("Auto stock canceled (UI).", "warning");
        return;
      }
      openManualStockModal();
    },
    "btn-manual-cmd": () => {
      const cmd = document.getElementById("manual-cmd")?.value.trim();
      if (!cmd) {
        showNotification("Please enter a command", "warning");
        return;
      }
      sendOperation("MANUAL_CMD", cmd);
    },

   "btn-quick-auto-start": () => quickStartAutoMode(),
   "btn-start-auto": () => startAutoMode(),
     "btn-stop-auto": () => stopAutoMode(),
   "btn-add-task": () => {
    updateTaskFields();
    if (elements.taskModal) elements.taskModal.classList.add("active");
    },
   "btn-clear-tasks": () => clearAllTasks(),
     "btn-auto-stock": () => addAutoTask({
    task_type: "STOCK_FROM_CONVEYOR",
    priority: "MEDIUM",
    storage_strategy: state.storageStrategy
  }),
  "btn-auto-retrieve": () => addAutoTask({
    task_type: "RETRIEVE_TO_LOADING",
    priority: "MEDIUM",
    storage_strategy: state.storageStrategy
  })}

  Object.entries(controls).forEach(([id, handler]) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", handler);
  });

  const manualCmdInput = document.getElementById("manual-cmd");
  if (manualCmdInput) {
    manualCmdInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") document.getElementById("btn-manual-cmd")?.click();
    });
  }
}

function setupAutoControls() {
  const controls = {
    "btn-start-auto": () => startAutoMode(),
    "btn-stop-auto": () => stopAutoMode(),
    "btn-add-task": () => {
      updateTaskFields();
      if (elements.taskModal) elements.taskModal.classList.add("active");
    },
    "btn-clear-tasks": () => clearAllTasks(),
    "btn-auto-stock": () => addAutoTask({
      task_type: "STOCK_FROM_CONVEYOR",
      priority: "MEDIUM",
      storage_strategy: state.storageStrategy
    }),
    "btn-auto-retrieve": () => addAutoTask({
      task_type: "RETRIEVE_TO_LOADING",
      priority: "MEDIUM",
      storage_strategy: state.storageStrategy
    })
  };

  Object.entries(controls).forEach(([id, handler]) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", handler);
  });
}

function setupProductManagement() {
  const btnAddProduct = document.getElementById("btn-add-product");
  if (btnAddProduct) btnAddProduct.addEventListener("click", addProduct);

  const btnAssignProduct = document.getElementById("btn-assign-product");
  if (btnAssignProduct) btnAssignProduct.addEventListener("click", assignProduct);

  const btnMoveToLoading = document.getElementById("btn-move-to-loading");
  if (btnMoveToLoading) btnMoveToLoading.addEventListener("click", moveToLoading);
}

function setupTaskManagement() {
  const modalClose = elements.taskModal?.querySelector(".modal-close");
  if (modalClose) {
    modalClose.addEventListener("click", () => {
      elements.taskModal.classList.remove("active");
    });
  }

  const btnCancelTask = document.getElementById("btn-cancel-task");
  if (btnCancelTask) {
    btnCancelTask.addEventListener("click", () => {
      elements.taskModal.classList.remove("active");
    });
  }

  
  const taskTypeSelect = document.getElementById("task-type");
  if (taskTypeSelect) {
    taskTypeSelect.addEventListener("change", updateTaskFields);
  }

  const btnSaveTask = document.getElementById("btn-save-task");
  if (btnSaveTask) {
    btnSaveTask.addEventListener("click", async () => {
      const type = document.getElementById("task-type")?.value;
      const priority = document.getElementById("task-priority")?.value || "MEDIUM";
      const strategy = document.getElementById("task-strategy")?.value || state.storageStrategy;

      const cellId = document.getElementById("task-cell")?.value || null;
      const productId = document.getElementById("task-product")?.value || null;

      const stockQty = parseInt(document.getElementById("task-stock-qty")?.value || "1", 10) || 1;
      // Reorganize/Load Return removed in final version

      if (!type) {
        showNotification("Please select task type", "warning");
        return;
      }

      try {
        if (type === "STOCK_FROM_CONVEYOR") {
          await addAutoTask({
            task_type: "STOCK_FROM_CONVEYOR",
            target_quantity: Math.max(1, stockQty),
            priority,
            storage_strategy: strategy
          });
        } else if (type === "RETRIEVE_TO_LOADING") {
          if (!cellId && !productId) {
            showNotification("Select a product or a source cell", "warning");
            return;
          }
          await addAutoTask({
            task_type: "RETRIEVE_TO_LOADING",
            cell_id: cellId ? parseInt(cellId, 10) : null,
            product_id: productId ? parseInt(productId, 10) : null,
            priority,
            storage_strategy: strategy
          });
        } else if (type === "MOVE_TO_LOADING") {
          if (!cellId && !productId) {
            showNotification("Select a product or a source cell", "warning");
            return;
          }
          await addAutoTask({
            task_type: "MOVE_TO_LOADING",
            cell_id: cellId ? parseInt(cellId, 10) : null,
            product_id: productId ? parseInt(productId, 10) : null,
            priority,
            storage_strategy: strategy
          });
        }

        elements.taskModal?.classList.remove("active");
      } catch (e) {
        // notification already shown
      }
    });
  }
}

function setupLoadingZoneControls() {
  const controls = {
    "btn-loading-open": () => controlLoadingZone("open"),
    "btn-loading-close": () => controlLoadingZone("close"),
    "btn-loading-check": () => controlLoadingZone("check")
  };

  Object.entries(controls).forEach(([id, handler]) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", handler);
  });
}

function setupConveyorControls() {
  const controls = {
    "btn-conveyor-move": () => controlConveyor("move"),
    "btn-conveyor-stop": () => controlConveyor("stop")
  };

  Object.entries(controls).forEach(([id, handler]) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", handler);
  });
}

function setupStrategyButtons() {
  const strategyButtons = [
    { id: "btn-strategy-nearest", strategy: "NEAREST_EMPTY" },
    { id: "btn-strategy-round", strategy: "NEAREST_EMPTY" },
    { id: "btn-strategy-random", strategy: "NEAREST_EMPTY" },
    { id: "btn-strategy-ai", strategy: "AI_OPTIMIZED" },
    { id: "btn-strategy-fixed", strategy: "FIXED" }
  ];

  strategyButtons.forEach(btn => {
    const element = document.getElementById(btn.id);
    if (element) {
      element.addEventListener("click", () => setStorageStrategy(btn.strategy));
    }
  });
}

function setupSensorTestButtons() {
  const controls = {
    "btn-test-ir-sensors": () => sendOperation("MANUAL_CMD", "TEST_IR_SENSORS"),
    "btn-test-ultrasonic": () => sendOperation("MANUAL_CMD", "TEST_ULTRASONIC"),
    "btn-test-rfid": () => sendOperation("MANUAL_CMD", "TEST_RFID"),
    "btn-test-conveyor": () => sendOperation("MANUAL_CMD", "TEST_CONVEYOR")
  };

  Object.entries(controls).forEach(([id, handler]) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", handler);
  });
}

// ========== UTILITY FUNCTIONS ==========
async function apiCall(endpoint, method = "GET", data = null, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
  };

  if (data) options.body = JSON.stringify(data);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    const msg = (error && error.name === "AbortError")
      ? "Request timed out"
      : (error?.message || String(error));
    console.error(`API ${endpoint} failed:`, msg);
    throw new Error(msg);
  } finally {
    clearTimeout(t);
  }
}

function showNotification(message, type = "info") {
  const existing = document.querySelector(".notification");
  if (existing) existing.remove();

  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.innerHTML = `
    <div class="notification-content">
      <span class="notification-icon">${getNotificationIcon(type)}</span>
      <span class="notification-message">${message}</span>
    </div>
  `;

  document.body.appendChild(notification);

  setTimeout(() => notification.classList.add("show"), 10);

  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function getNotificationIcon(type) {
  const icons = {
    success: "✅",
    error: "❌",
    warning: "⚠️",
    info: "ℹ️"
  };
  return icons[type] || "ℹ️";
}

function getStatusColor(status) {
  const colors = {
    PENDING: "yellow",
    PROCESSING: "blue",
    COMPLETED: "green",
    ERROR: "red",
    CANCELLED: "gray"
  };
  return colors[status] || "gray";
}

function updateSystemSettings(settings) {
  if (!settings) return;
  
  const autoModeSwitch = document.getElementById("auto-mode-switch");
  if (autoModeSwitch) autoModeSwitch.checked = settings.auto_mode || false;
  
  const conveyorManualSwitch = document.getElementById("conveyor-manual-switch");
  if (conveyorManualSwitch) conveyorManualSwitch.checked = settings.conveyor_manual_control || false;
}

async function clearAllTasks() {
  try {
    await apiCall("/api/auto-tasks/clear", "POST");
    showNotification("All tasks cleared", "success");
    await loadWarehouseData();
  } catch (error) {
    showNotification("Failed to clear tasks", "error");
  }
}

function updateTaskFields() {
  const type = document.getElementById("task-type")?.value;

  const stockGroup = document.getElementById("task-stock-qty-group");
  const reorgGroup = document.getElementById("task-reorg-mode-group"); // legacy (not used)
  const cellGroup = document.getElementById("task-cell-group");
  const prodGroup = document.getElementById("task-product-group");

  if (stockGroup) stockGroup.style.display = "none";
  if (reorgGroup) reorgGroup.style.display = "none";
  if (cellGroup) cellGroup.style.display = "none";
  if (prodGroup) prodGroup.style.display = "none";

  if (type === "STOCK_FROM_CONVEYOR") {
    if (stockGroup) stockGroup.style.display = "block";
  } else if (type === "RETRIEVE_TO_LOADING" || type === "MOVE_TO_LOADING") {
    if (prodGroup) prodGroup.style.display = "block";
    if (cellGroup) cellGroup.style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", init);
