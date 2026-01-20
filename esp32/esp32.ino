#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ===== WiFi =====
const char* ssid     = "Hmood iphone";
const char* password = "mohammad123";

// ===== Node Server (Dynamic) =====
String serverHost = "172.20.10.3";
uint16_t serverPort = 5001;

// ===== Serial to Arduino Mega (UART2) =====
HardwareSerial ArduinoSerial(2);  // RX=16, TX=17
WebServer server(80);

// ===== Sensor Data Snapshot =====
struct SensorData {
  bool ldr1 = false;
  bool ldr2 = false;
  String rfid = "";
  String conveyorState = "IDLE";
  String armStatus = "READY";
  String currentRfidSymbol = "";
  String targetCell = "";
  unsigned long lastUpdate = 0;
  String currentOperation = "";
  bool cellOccupied[3][4] = {{false}}; // 3 rows x 4 cols
  bool loadingZoneOccupied = false;
  String storageStrategy = "NEAREST_EMPTY";
};

SensorData sensorData;

// ===== Forward Declarations =====
void registerWithServer();
void sendSensorDataToServer();
void updateCellStatus(int row, int col, bool occupied);
void updateLoadingZoneStatus(bool occupied);
void parseArduinoMessage(String message);

void handleRoot();
void handleCmd();
void handleSetServer();
void handleNotFound();

int getIRPin(int row, int col);

// ========== REGISTER ESP32 WITH NODE ==========
void registerWithServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  IPAddress ip = WiFi.localIP();
  String ipStr = ip.toString();

  String url = "http://" + serverHost + ":" + String(serverPort) +
               "/api/esp32/register?ip=" + ipStr;

  Serial.print("Registering ESP32 at: ");
  Serial.println(url);

  HTTPClient http;
  http.begin(url);
  int httpCode = http.GET();

  if (httpCode == 200) {
    Serial.println("Successfully registered with server");
  } else {
    Serial.print("Registration failed, code: ");
    Serial.println(httpCode);
  }
  http.end();
}

// ========== SEND SENSOR DATA ==========
void sendSensorDataToServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  String url = "http://" + serverHost + ":" + String(serverPort) + "/api/sensors/update";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // Node expects:
  // { ldr1, ldr2, rfid, conveyorState, armStatus, currentOperation,
  //   loadingZoneOccupied, storageStrategy, cells:[[bool..],[..],[..]] }
  StaticJsonDocument<1200> doc;
  doc["ldr1"] = sensorData.ldr1;
  doc["ldr2"] = sensorData.ldr2;
  doc["rfid"] = sensorData.rfid;
  doc["conveyorState"] = sensorData.conveyorState;
  doc["armStatus"] = sensorData.armStatus;
  doc["currentOperation"] = sensorData.currentOperation;
  doc["targetCell"] = sensorData.targetCell;
  doc["currentRfidSymbol"] = sensorData.currentRfidSymbol;
  doc["loadingZoneOccupied"] = sensorData.loadingZoneOccupied;
  doc["storageStrategy"] = sensorData.storageStrategy;

  JsonArray grid = doc.createNestedArray("cells");
  for (int r = 0; r < 3; r++) {
    JsonArray row = grid.createNestedArray();
    for (int c = 0; c < 4; c++) {
      row.add(sensorData.cellOccupied[r][c]);
    }
  }

  String jsonString;
  serializeJson(doc, jsonString);

  int httpCode = http.POST(jsonString);

  if (httpCode != 200) {
    Serial.print("Failed to send sensor data, code: ");
    Serial.println(httpCode);
  }

  http.end();
}


// Notify Node.js when the product reached IR2/LDR2 and is ready to pick
void notifyConveyorReadyToServer(const String &rfid) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = "http://" + serverHost + ":" + String(serverPort) + "/api/conveyor/ready";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["rfid"] = rfid;

  String payload;
  serializeJson(doc, payload);

  int code = http.POST(payload);
  Serial.print("[Node] /api/conveyor/ready -> ");
  Serial.println(code);

  http.end();
}



// ========== UPDATE CELL STATUS ==========
void updateCellStatus(int row, int col, bool occupied) {
  if (row >= 1 && row <= 3 && col >= 1 && col <= 4) {
    sensorData.cellOccupied[row - 1][col - 1] = occupied;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }
}

// ========== UPDATE LOADING ZONE ==========
void updateLoadingZoneStatus(bool occupied) {
  sensorData.loadingZoneOccupied = occupied;

  if (WiFi.status() == WL_CONNECTED) {
    String url = "http://" + serverHost + ":" + String(serverPort) + "/api/loading-zone";

    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<128> doc;
    if (occupied) {
      doc["product_id"] = 1; // Default product ID
      doc["quantity"] = 1;
    } else {
      doc["product_id"] = nullptr;
      doc["quantity"] = 0;
    }

    String jsonString;
    serializeJson(doc, jsonString);
    http.POST(jsonString);
    http.end();
  }

  // مهم جدًا: ابعث snapshot للـ UI فورًا
  sensorData.lastUpdate = millis();
  sendSensorDataToServer();
}

// ========== PARSE ARDUINO MESSAGES ==========
void parseArduinoMessage(String message) {
  message.trim();
  if (message.length() == 0) return;

  Serial.print("From Arduino: ");
  Serial.println(message);

  // MEGA -> ESP32: product reached IR2/LDR2 and is ready to pick
  if (message.startsWith("CONVEYOR_READY:")) {
    String rfid = message.substring(String("CONVEYOR_READY:").length());
    rfid.trim();
    if (rfid.length() > 0) {
      sensorData.rfid = rfid;
      sensorData.conveyorState = "READY_PICK";
      sensorData.lastUpdate = millis();
      notifyConveyorReadyToServer(rfid);
    }
    return;
  }


  // SENSOR DATA UPDATE
  if (message.startsWith("SENSOR:")) {
    message = message.substring(7);

    int c1 = message.indexOf(',');
    int c2 = message.indexOf(',', c1 + 1);
    int c3 = message.indexOf(',', c2 + 1);
    int c4 = message.indexOf(',', c3 + 1); // optional 5th field

    if (c1 > 0 && c2 > 0 && c3 > 0) {
      String sLdr1 = message.substring(0, c1);
      String sLdr2 = message.substring(c1 + 1, c2);
      String sRfid = message.substring(c2 + 1, c3);

      String sConv;
      String sLz = ""; // optional

      if (c4 > 0) {
        sConv = message.substring(c3 + 1, c4);
        sLz   = message.substring(c4 + 1);
      } else {
        sConv = message.substring(c3 + 1);
      }

      sensorData.ldr1 = (sLdr1 == "1");
      sensorData.ldr2 = (sLdr2 == "1");
      sensorData.rfid = sRfid;

      if (sLz.length() > 0) {
        sensorData.loadingZoneOccupied = (sLz == "1");
      }

      int convVal = sConv.toInt();
      switch (convVal) {
        case 0: sensorData.conveyorState = "IDLE"; break;
        case 1: sensorData.conveyorState = "MOVE_12CM"; break;
        case 2: sensorData.conveyorState = "WAIT_RFID"; break;
        case 3: sensorData.conveyorState = "MOVING_TO_LDR2"; break;
        case 4: sensorData.conveyorState = "STOPPED"; break;
        default: sensorData.conveyorState = "UNKNOWN"; break;
      }

      sensorData.lastUpdate = millis();
      sendSensorDataToServer();
    }
  }

  // CELL STATUS UPDATE
  else if (message.startsWith("CELL_STATUS:")) {
    message = message.substring(12);
    int c1 = message.indexOf(':');
    int c2 = message.indexOf(':', c1 + 1);

    if (c1 > 0 && c2 > 0) {
      int row = message.substring(0, c1).toInt();
      int col = message.substring(c1 + 1, c2).toInt();
      bool occupied = (message.substring(c2 + 1) == "1");

      updateCellStatus(row, col, occupied);
    }
  }

  // LOADING ZONE UPDATE
  else if (message.startsWith("LOADING_ZONE:")) {
    String status = message.substring(13);
    bool occupied = (status == "OCCUPIED");

    updateLoadingZoneStatus(occupied);
    sendSensorDataToServer();

  }

  // IR GRID SNAPSHOT (periodic sync)
  else if (message.startsWith("IR_GRID:")) {
    // Format: IR_GRID:v1,v2,...,v12  (row-major)
    String payload = message.substring(8);
    int idx = 0;
    int start = 0;
    for (int r = 0; r < 3; r++) {
      for (int c = 0; c < 4; c++) {
        int comma = payload.indexOf(',', start);
        String tok;
        if (comma >= 0) {
          tok = payload.substring(start, comma);
          start = comma + 1;
        } else {
          tok = payload.substring(start);
          start = payload.length();
        }
        tok.trim();
        sensorData.cellOccupied[r][c] = (tok == "1");
        idx++;
      }
    }
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // Short LZ update (Mega sends: LZ:1 / LZ:0)
  else if (message.startsWith("LZ:")) {
    String v = message.substring(3);
    v.trim();
    sensorData.loadingZoneOccupied = (v == "1");
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // RFID DETECTION
  else if (message.startsWith("RFID:")) {
    message = message.substring(5);
    int colonPos = message.indexOf(':');
    if (colonPos > 0) {
      sensorData.rfid = message.substring(0, colonPos);
      sensorData.currentRfidSymbol = message.substring(colonPos + 1);
      sensorData.lastUpdate = millis();
      sendSensorDataToServer();
    }
  }

  // CELL UPDATE (ARM PLACED/PICKED FROM CELL)
  else if (message.startsWith("CELL:")) {
    message = message.substring(5);
    int c1 = message.indexOf(':');
    int c2 = message.indexOf(':', c1 + 1);
    int c3 = message.indexOf(':', c2 + 1);

    if (c1 > 0 && c2 > 0 && c3 > 0) {
      String col = message.substring(0, c1);
      String row = message.substring(c1 + 1, c2);
      String action = message.substring(c2 + 1, c3);
      String status = message.substring(c3 + 1);

      sensorData.targetCell = "C" + col + "R" + row;

      if (action == "PLACED") {
        updateCellStatus(row.toInt(), col.toInt(), true);
      } else if (action == "TAKEN") {
        updateCellStatus(row.toInt(), col.toInt(), false);
      } else if (action == "SENSOR_UPDATE") {
        bool occ = (status == "OCCUPIED");
        updateCellStatus(row.toInt(), col.toInt(), occ);
      }

      sensorData.lastUpdate = millis();
    }
  }

  // TARGET CELL FROM MEGA (during auto stock)
  else if (message.startsWith("TARGET_CELL:")) {
    String params = message.substring(12);
    params.trim();
    // format: col:row
    sensorData.targetCell = params;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // AUTO STOCK STATUS (more precise than generic STATUS)
  else if (message.startsWith("AUTO_STOCK_START:")) {
    sensorData.currentOperation = message;
    sensorData.armStatus = "BUSY";
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }
  else if (message.startsWith("AUTO_STOCK_COMPLETE:")) {
    sensorData.currentOperation = message;
    sensorData.armStatus = "READY";
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }
  else if (message.startsWith("AUTO_STOCK_ERROR:")) {
    sensorData.currentOperation = message;
    sensorData.armStatus = "ERROR";
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // Stock from conveyor progress
  else if (message.startsWith("STOCK_QTY_LEFT:")) {
    sensorData.currentOperation = message;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }
  // New firmware: Mega sends "STOCK_QTY_COMPLETE:<qty>"
  else if (message.startsWith("STOCK_QTY_COMPLETE")) {
    sensorData.currentOperation = message;
    sensorData.armStatus = "READY";
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }
  else if (message == "STOCK_QTY_DONE") {
    sensorData.currentOperation = message;
    sensorData.armStatus = "READY";
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // Product moved into loading zone
  else if (message.startsWith("PRODUCT_IN_LOADING:")) {
    sensorData.currentOperation = message;
    sensorData.loadingZoneOccupied = true;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  
  else if (message.startsWith("STATUS:")) {
    String s = message.substring(7);
    s.trim();

    sensorData.currentOperation = s;

    // Consider COMPLETE as READY
    if (s.endsWith("COMPLETE") || s.indexOf("COMPLETE") >= 0) sensorData.armStatus = "READY";
    else if (s.indexOf("ERROR") >= 0) sensorData.armStatus = "ERROR";
    else sensorData.armStatus = "BUSY";

    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // MODE UPDATE
  else if (message.startsWith("MODE:")) {
    String mode = message.substring(5);
    Serial.print("Mode changed to: ");
    Serial.println(mode);
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // STRATEGY UPDATE
  else if (message.startsWith("STRATEGY:")) {
    sensorData.storageStrategy = message.substring(9);
    Serial.print("Storage strategy: ");
    Serial.println(sensorData.storageStrategy);
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // STATE UPDATE
  else if (message.startsWith("STATE:")) {
    String state = message.substring(6);
    Serial.print("State: ");
    Serial.println(state);
    // Keep these two in-sync so the server/UI can show progress reliably
    sensorData.conveyorState = state;
    sensorData.currentOperation = "STATE:" + state;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // One-shot cycle done marker
  else if (message == "AUTO_ONESHOT_DONE") {
    sensorData.currentOperation = message;
    sensorData.armStatus = "READY";
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // ARDUINO READY
  else if (message == "ARDUINO:READY") {
    sensorData.armStatus = "READY";
    sensorData.currentOperation = "System Ready";
    sensorData.lastUpdate = millis();
    Serial.println("Arduino is ready");
    sendSensorDataToServer();
  }

  // COMMAND PROCESSING
  else if (message.startsWith("CMD_RECEIVED:")) {
    String cmd = message.substring(12);
    Serial.print("Arduino processing command: ");
    Serial.println(cmd);
    sensorData.currentOperation = "Processing: " + cmd;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }

  // TASK ADDED
  else if (message.startsWith("TASK_ADDED:")) {
    String task = message.substring(11);
    Serial.print("Task added: ");
    Serial.println(task);
    sensorData.currentOperation = "Task added: " + task;
    sensorData.lastUpdate = millis();
    sendSensorDataToServer();
  }
}

// ========== HTTP HANDLERS ==========
int getIRPin(int row, int col) {
  const int pins[3][4] = {
    {53, 31, 23, 30},
    {52, 32, 33, 34},
    {35, 25, 40, 22}
  };
  return pins[row][col];
}

void handleRoot() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<title>ESP32 Warehouse Bridge</title>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1'>";
  html += "<style>";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; }";
  html += ".container { max-width: 1000px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }";
  html += "h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }";
  html += ".status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }";
  html += ".status-item { background: #f8f9fa; padding: 15px; border-radius: 5px; border-left: 4px solid #007bff; }";
  html += ".status-label { font-weight: bold; color: #666; display: block; margin-bottom: 5px; }";
  html += ".status-value { font-size: 1.1em; color: #333; }";
  html += ".active { color: green; font-weight: bold; }";
  html += ".inactive { color: #666; }";
  html += ".cell-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin: 20px 0; }";
  html += ".cell { padding: 10px; text-align: center; border-radius: 3px; font-size: 0.9em; }";
  html += ".cell-occupied { background: #d4edda; border: 1px solid #c3e6cb; }";
  html += ".cell-empty { background: #f8f9fa; border: 1px solid #e9ecef; }";
  html += ".loading-zone { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0; }";
  html += ".strategy-info { background: #e7f3ff; border: 1px solid #b3d7ff; padding: 15px; border-radius: 5px; margin: 20px 0; }";
  html += "</style></head><body>";
  html += "<div class='container'>";
  html += "<h1>ESP32 Smart Warehouse Bridge</h1>";
  html += "<p><strong>IP Address:</strong> " + WiFi.localIP().toString() + "</p>";
  html += "<p><strong>Server:</strong> " + serverHost + ":" + String(serverPort) + "</p>";

  html += "<div class='strategy-info'>";
  html += "<h3>Current Storage Strategy</h3>";
  html += "<p><strong>" + sensorData.storageStrategy + "</strong></p>";
  html += "</div>";

  html += "<div class='status-grid'>";

  html += "<div class='status-item'><span class='status-label'>LDR1 (Entry)</span>";
  html += "<span class='status-value " + String(sensorData.ldr1 ? "active" : "inactive") + "'>";
  html += sensorData.ldr1 ? "ACTIVE" : "INACTIVE";
  html += "</span></div>";

  html += "<div class='status-item'><span class='status-label'>LDR2 (Exit)</span>";
  html += "<span class='status-value " + String(sensorData.ldr2 ? "active" : "inactive") + "'>";
  html += sensorData.ldr2 ? "ACTIVE" : "INACTIVE";
  html += "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Conveyor State</span>";
  html += "<span class='status-value'>" + sensorData.conveyorState + "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Arm Status</span>";
  html += "<span class='status-value'>" + sensorData.armStatus + "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Current Operation</span>";
  html += "<span class='status-value'>" + sensorData.currentOperation + "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Current RFID</span>";
  html += "<span class='status-value'>" + (sensorData.rfid.length() > 0 ? sensorData.rfid : "None") + "</span></div>";

  html += "<div class='status-item'><span class='status-label'>RFID Symbol</span>";
  html += "<span class='status-value'>" + sensorData.currentRfidSymbol + "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Target Cell</span>";
  html += "<span class='status-value'>" + (sensorData.targetCell.length() > 0 ? sensorData.targetCell : "None") + "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Loading Zone</span>";
  html += "<span class='status-value " + String(sensorData.loadingZoneOccupied ? "active" : "inactive") + "'>";
  html += sensorData.loadingZoneOccupied ? "OCCUPIED" : "EMPTY";
  html += "</span></div>";

  html += "<div class='status-item'><span class='status-label'>Last Update</span>";
  html += "<span class='status-value'>" + String((millis() - sensorData.lastUpdate) / 1000) + " seconds ago</span></div>";

  html += "</div>";

  html += "<div class='loading-zone'>";
  html += "<h3>Loading Zone Status</h3>";
  html += "<p><strong>Status:</strong> " + String(sensorData.loadingZoneOccupied ? "OCCUPIED" : "EMPTY") + "</p>";
  html += "<p><strong>Ultrasonic Sensor:</strong> Connected (TX1/RX1)</p>";
  html += "<p><strong>Servo:</strong> Arduino Pin 46</p>"; // تصحيح (حسب كود Mega عندك)
  html += "</div>";

  html += "<h3>Cell Occupancy Status (IR Sensors)</h3>";
  html += "<div class='cell-grid'>";
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {
      bool occupied = sensorData.cellOccupied[row][col];
      html += "<div class='cell " + String(occupied ? "cell-occupied" : "cell-empty") + "'>";
      html += "R" + String(row + 1) + "C" + String(col + 1);
      html += "<br><small>" + String(occupied ? "OCCUPIED" : "EMPTY") + "</small>";
      html += "<br><small>Pin: " + String(getIRPin(row, col)) + "</small>";
      html += "</div>";
    }
  }
  html += "</div>";

  html += "<h3>Commands</h3>";
  html += "<p>Use /cmd?c=COMMAND to send commands to Arduino.</p>";
  html += "<p>Set server: /set-server?ip=192.168.1.10&port=5001</p>";

  html += "</div></body></html>";
  server.send(200, "text/html", html);
}

void handleCmd() {
  if (!server.hasArg("c")) {
    server.send(400, "text/plain", "Missing 'c' query parameter");
    return;
  }

  String cmd = server.arg("c");
  cmd.trim();

  Serial.print("Sending to Arduino: ");
  Serial.println(cmd);

  ArduinoSerial.print(cmd);
  ArduinoSerial.print("\n");

  server.send(200, "text/plain", "Sent to Arduino: " + cmd);
}

void handleSetServer() {
  if (!server.hasArg("ip")) {
    server.send(400, "text/plain",
      "Missing ip. Example: /set-server?ip=192.168.1.10&port=5001");
    return;
  }

  serverHost = server.arg("ip");
  if (server.hasArg("port")) {
    serverPort = (uint16_t)server.arg("port").toInt();
  }

  registerWithServer();
  server.send(200, "text/plain",
    "Server updated to: " + serverHost + ":" + String(serverPort));
}

void handleNotFound() {
  server.send(404, "text/plain", "Not Found");
}

// ========== SETUP / LOOP ==========
void setup() {
  Serial.begin(115200);
  delay(200);

  ArduinoSerial.begin(115200, SERIAL_8N1, 16, 17);
  ArduinoSerial.setTimeout(1);   

  Serial.println("ESP32 Bridge starting...");

  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
    Serial.print(".");
  }

  WiFi.setSleep(false);          // ✅ الأفضل بعد الاتصال

  Serial.println();
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());

  registerWithServer();

  server.on("/", handleRoot);
  server.on("/cmd", handleCmd);
  server.on("/set-server", handleSetServer);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server started on port 80.");

  // Initialize state
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {
      sensorData.cellOccupied[row][col] = false;
    }
  }
  sensorData.loadingZoneOccupied = false;
  sensorData.lastUpdate = millis();

  Serial.println("ESP32 Bridge Ready!");
}


void loop() {
  server.handleClient();

  // Read from Arduino
  if (ArduinoSerial.available()) {
    String line = ArduinoSerial.readStringUntil('\n');
    parseArduinoMessage(line);
  }

  // Periodically send sensor data (every 1 second) as backup
  static unsigned long lastSensorSend = 0;
  if (millis() - lastSensorSend > 2000) {
    sendSensorDataToServer();
    lastSensorSend = millis();
  }

  static unsigned long lastRegister = 0;
  if (millis() - lastRegister > 30000) {
    if (WiFi.status() == WL_CONNECTED) {
      registerWithServer();
    }
    lastRegister = millis();
  }
}