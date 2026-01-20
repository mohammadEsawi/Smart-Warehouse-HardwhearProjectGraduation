// SMART WAREHOUSE ARM ROBOT - COMPLETE VERSION WITH IR SENSORS, ULTRASONIC & CONVEYOR
#include <Servo.h>
#include <PN532_HSU.h>
#include <PN532.h>
#include <AccelStepper.h>
#include <LiquidCrystal_I2C.h>

// LCD setup
LiquidCrystal_I2C lcd(0x27, 16, 2);

void lcdStatus(const char* line1, const char* line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1);
  lcd.setCursor(0, 1);
  lcd.print(line2);
}

void lcdStatus(const String &l1, const String &l2) {
  lcdStatus(l1.c_str(), l2.c_str());
}

// ESP32 Communication
#define ESP_SERIAL Serial2
const long ESP_BAUD = 115200;

// Arm Stepper Configuration
const int ARM_DIR_PIN = 2;
const int ARM_STEP_PIN = 3;
const int ARM_ENABLE_PIN = 4;
const int LIMIT_SWITCH_PIN = 35;

uint8_t irSameCount[3][4] = {{0}};

const int STEPS_PER_CM = 50;
const float COL_ABS_CM[4] = {8, 22, 36, 50};
const int NUM_COLUMNS = 4;
const int NUM_ROWS = 3;

const int TRAP_DELAY_START_US = 1200;
const int TRAP_DELAY_MIN_US   = 400;
const float TRAP_RAMP_FRACTION = 0.3;
const bool DIR_AWAY_FROM_HOME = HIGH;
const bool DIR_TOWARD_HOME    = LOW;
const int BACKOFF_STEPS       = 50;

long currentStepPos = 0;

// Servo Configuration
Servo s1, s2, s3, s4, s5, s6, loadingServo;
const int S1_PIN = 30, S2_PIN = 32, S3_PIN = 34;
const int S4_PIN = 13, S5_PIN = 11, S6_PIN = 36;
const int LOADING_SERVO_PIN = 49;

int s1Default = 100;
int s2Default = 90;
int s3Default = 90;
int s4Default = 110;
int s5Default = 10;
int s6Default = 65;
int loadingServoDefault = 90;

int s1Pos = s1Default;
int s2Pos = s2Default;
int s3Pos = s3Default;
int s4Pos = s4Default;
int s5Pos = s5Default;
int s6Pos = s6Default;
int loadingServoPos = loadingServoDefault;

const float SERVO_SPEED_DPS_DEFAULT = 60.0f;

// ============================
//   GRIPPER (S1) HOLDING LOGIC
// ============================
// المشكلة كانت: بعد الـ PICK الكود ينادي returnToDefaultPosition() واللي يرجّع s1
// لزاوية ثانية فتبدو كأن الجربر "فتح".
// الحل: لما نكون ماسكين قطعة (gripperHolding=true) ممنوع نغيّر s1 داخل
// returnToDefaultPosition().
bool gripperHolding = false;

// ============================
//       IR SENSOR PINS
// ============================
const int R1C1_PIN = 37;  // Row 1, Column 1
const int R1C2_PIN = 38;  // Row 1, Column 2
const int R1C3_PIN = 39;  // Row 1, Column 3
const int R1C4_PIN = 40;  // Row 1, Column 4

const int R2C1_PIN = 41;  // Row 2, Column 1
const int R2C2_PIN = 42;  // Row 2, Column 2
const int R2C3_PIN = 43;  // Row 2, Column 3
const int R2C4_PIN = 44;  // Row 2, Column 4

const int R3C1_PIN = 45;  // Row 3, Column 1
const int R3C2_PIN = 46;  // Row 3, Column 2
const int R3C3_PIN = 47;  // Row 3, Column 3
const int R3C4_PIN = 48;  // Row 3, Column 4

// IR Sensor Array
const int IR_PINS[3][4] = {
  {R1C1_PIN, R1C2_PIN, R1C3_PIN, R1C4_PIN},
  {R2C1_PIN, R2C2_PIN, R2C3_PIN, R2C4_PIN},
  {R3C1_PIN, R3C2_PIN, R3C3_PIN, R3C4_PIN}
};


const bool IR_USE_PULLUP = true;

// Baseline level لكل IR (HIGH/LOW)
uint8_t irBaseline[3][4] = {{HIGH}};

// quick sampling to ignore short blips from IR modules
const uint8_t IR_SAMPLES = 9;
const uint8_t IR_SAMPLE_DELAY_MS = 2;
const uint8_t IR_MAJORITY = 5;

// Debounce / Confirm (كم مرة لازم يتأكد قبل ما نغيّر الحالة)
const uint8_t IR_CONFIRM_N = 6;            // ارفعها لو لسه في وميض
const uint16_t IR_MIN_CHANGE_MS = 250;     // أقل زمن بين تبديل حالة وحالة

const uint8_t  IR_CLEAR_CONFIRM_N = 14;    // عدد تأكيدات لإفراغ الخلية
const uint16_t IR_CLEAR_MIN_CHANGE_MS = 1500; // أقل زمن لإعتماد التفريغ
const uint16_t IR_CLEAR_MIN_MS    = 1800;  // لازم يمر هذا الوقت قبل اعتماد التفريغ

bool cellSensor[3][4] = {{false}};         // IR sensor stable state only
bool irCandidate[3][4] = {{false}};        // candidate state
uint8_t irCount[3][4] = {{0}};             // confirm counter
unsigned long irLastChangeMs[3][4] = {{0}}; // last committed change time

bool cellOccupied[3][4] = {{false}};   // True if IR sensor detects object
bool lastCellStatus[3][4] = {{false}}; // For detecting changes

// ============================
//       ULTRASONIC SENSOR
// ============================
#define ULTRA_TRIG 15   // TRIG = 15
#define ULTRA_ECHO 14   // ECHO = 14
const int LZ_OCCUPIED_CM = 6;
const int LZ_EMPTY_CM = 10;
const int LZ_CONFIRM_N = 3;
bool loadingZoneOccupied = false;
int lzConfirmCounter = 0;
const int SCAN_CENTER = loadingServoDefault;     
int scanAngle = SCAN_CENTER;

int scanDir = +1; // +1 رايح يمين, -1 رايح يسار
unsigned long lastScanMoveMs = 0;
unsigned long lastUltraReadMs = 0;

long lastScanMinCm = -1;

const int SCAN_LEFT   = loadingServoDefault - 25; 
const int SCAN_RIGHT  = loadingServoDefault + 25; 

const int SERVO_SETTLE_MS = 180; 

long ultraReadFilteredCM();

void updateLoadingZoneScan() {
  // 1) حرّك السيرفو درجة درجة باستمرار
  const int MOVE_EVERY_MS = 20;  // سرعة اللف (قللها = أسرع)
  if (millis() - lastScanMoveMs >= MOVE_EVERY_MS) {
    lastScanMoveMs = millis();

    scanAngle += scanDir;

    if (scanAngle >= SCAN_RIGHT) { scanAngle = SCAN_RIGHT; scanDir = -1; }
    if (scanAngle <= SCAN_LEFT)  { scanAngle = SCAN_LEFT;  scanDir = +1; }

    loadingServo.write(scanAngle);
    loadingServoPos = scanAngle;
  }

  // 2) اقرأ الالترا كل فترة قصيرة وخزن أقل مسافة
  const int READ_EVERY_MS = 120;
  if (millis() - lastUltraReadMs >= READ_EVERY_MS) {
    lastUltraReadMs = millis();

    long cm = ultraReadFilteredCM();
    if (cm > 0) {
      lastScanMinCm = cm;
    }
  }
}

// ===== Continuous Scan (non-blocking) =====
  // آخر أقل مسافة تم رصدها أثناء اللف

// ============================
//       CONVEYOR SETTINGS (UPDATED FROM FIRST CODE)
// ============================
#define CONV_DIR_PIN   5
#define CONV_STEP_PIN  6
#define CONV_EN_PIN    7

#define LDR1_PIN  9   // أول حساس (بداية القشط)
#define LDR2_PIN  8   // ثاني حساس (نهاية القشط)

// ---------- Settings ----------
/*
  Conveyor sensors (LDR/IR):
  بنعمل Baseline عند الإقلاع، والجسم = القراءة مختلفة عن الـ Baseline.
*/
const bool LDR_USE_PULLUP = true;
uint8_t ldr1Baseline = HIGH;
uint8_t ldr2Baseline = HIGH;
const bool CONV_EN_ACTIVE_LOW = true;
const float CONV_STEPPER_MAX_SPEED = 5000.0; // Faster (MS1=1, MS2=0, MS3=0) without changing microstep pins
const float CONV_STEPPER_ACCEL = 3000.0; // Smoother acceleration to reduce noise
const long STEPS_PER_12CM = 600;    // 12 سم = 600 ستيب

// ============================
//           RFID
// ============================
PN532_HSU pn532hsu(Serial1);
PN532 nfc(pn532hsu);

// ============================
//       CONVEYOR STEPPER
// ============================
AccelStepper conveyorStepper(AccelStepper::DRIVER, CONV_STEP_PIN, CONV_DIR_PIN);

// ============================
//       SYSTEM STATES
// ============================
enum RunState {
  IDLE,         // لا شيء
  MOVE_12CM,    // تحريك الجسم 12 سم بعد LDR1
  WAIT_RFID,    // محاولة قراءة RFID
  MOVING_TO_LDR2, // يتحرك بعد قراءة التاج
  STOPPED,      // توقف عند LDR2
  MANUAL_MODE
};

RunState convState = IDLE;
RunState prevConvState = IDLE;

// ============================
//   MANUAL: PICK FROM CONVEYOR SEQUENCE
// ============================
// لما نكون في Manual mode ونضغط "Pick from Conveyor" بدنا:
// 1) نستنى LDR1
// 2) نمشي 12cm
// 3) نقرأ RFID
// 4) نمشي لحد LDR2
// 5) بعد LDR2 فقط الذراع يعمل PICK
enum ConveyorJob {
  JOB_NONE,
  JOB_AUTO_STOCK,   // (Auto mode) pick + place حسب الاستراتيجية
  JOB_MANUAL_PICK   // (Manual mode) pick فقط بعد LDR2
};

ConveyorJob conveyorJob = JOB_NONE;
bool manualPickArmed = false;
unsigned long manualPickStartMs = 0;
unsigned long waitRfidStartMs = 0;

// Timeouts (ms)
const unsigned long MANUAL_WAIT_LDR1_TIMEOUT_MS = 30000; // 30s
const unsigned long MANUAL_WAIT_RFID_TIMEOUT_MS = 5000;  // 5s

enum ArmMode {
  MODE_MANUAL,
  MODE_AUTO
};

ArmMode currentMode = MODE_MANUAL;
bool autoModeRunning = false;
// When triggered from the website "Pick From Conveyor (Auto)",
// we run exactly ONE conveyor-driven stock cycle then return to manual.
bool autoOneShot = false;

// ============================
//       RFID DATABASE
// ============================
const int NUM_TAGS = 6;
const char TAG_SYMBOLS[NUM_TAGS] = {'A', 'B', 'C', 'D', 'E', 'F'};
const char* TAG_IDS[NUM_TAGS] = {
  "12.80.110.3",
  "178.139.221.208",
  "204.187.101.3",
  "12.86.101.3",
  "66.208.30.83",
  "252.53.92.3"
};

// Storage Strategy Configuration
enum StorageStrategy {
  STRATEGY_NEAREST_EMPTY,
  STRATEGY_AI_OPTIMIZED,
  STRATEGY_FIXED
};

String rfidCellMap[3][4] = {{""}};



StorageStrategy currentStorageStrategy = STRATEGY_NEAREST_EMPTY;
int nextCellIndex = 0;
int fixedStorageMap[3][4] = {
  {1, 2, 3, 4},
  {5, 6, 7, 8},
  {9, 10, 11, 12}
};

int targetCol = -1;
int targetRow = -1;
char lastSymbol = '?';
String lastTag = "";
String currentRFID = "";

// ============================
//   AUTO TASK QUEUE
// ============================
struct AutoTask {
  String command;
  String rfid;
  int col;
  int row;
  bool pending;
};

AutoTask autoTasks[10];
int autoTaskCount = 0;
int currentTaskIndex = -1;

// ============================
//   FORWARD DECLARATIONS
// ============================
bool readLDRStable(uint8_t pin, uint8_t baselineLevel);
uint8_t calibrateBaseline(uint8_t pin, uint8_t samples = 25, uint8_t sampleDelayMs = 2);
void enableConveyorMotor(bool enable);
void returnToDefaultPosition();
int findTagIndex(const String &tag);
bool getCellFromStrategy(int &col, int &row, String rfid = "");
void updateCellOccupancyFromSensors();
bool checkLoadingZoneOccupied();
String readCommand(Stream &s);
void handleCommand(String cmd);
void sendToESP32(String message);
void sendStatusUpdate(String status);
void sendRFIDUpdate(String tag, String symbol);
void sendCellUpdate(int col, int row, String action, String status = "");
void sendLoadingZoneUpdate(bool occupied);
void sendCellStatusUpdate(int row, int col, bool occupied);
void sendAllCellStatus();
void sendSensorUpdate();

// ============================
//   LDR HELPER FUNCTIONS
// ============================
bool readLDRRaw(uint8_t pin, uint8_t baselineLevel) {
  int raw = digitalRead(pin);
  return (raw != baselineLevel);
}

bool readLDRStable(uint8_t pin, uint8_t baselineLevel) {
  uint8_t hits = 0;
  const uint8_t LDR_SAMPLES = 5;
  const uint8_t LDR_SAMPLE_MS = 2;
  
  for (uint8_t i = 0; i < LDR_SAMPLES; i++) {
    if (readLDRRaw(pin, baselineLevel)) hits++;
    delay(LDR_SAMPLE_MS);
  }
  return (hits >= (LDR_SAMPLES / 2 + 1));
}

// ============================
//   COMMUNICATION FUNCTIONS
// ============================
void sendToESP32(String message) {
  ESP_SERIAL.println(message);
  Serial.print("To ESP32: ");
  Serial.println(message);
}

void sendStatusUpdate(String status) {
  String msg = "STATUS:";
  msg += status;
  sendToESP32(msg);
}

void sendRFIDUpdate(String tag, String symbol) {
  String msg = "RFID:";
  msg += tag;
  msg += ":";
  msg += symbol;
  sendToESP32(msg);
}

void sendCellUpdate(int col, int row, String action, String status) {
  String msg = "CELL:";
  msg += col;
  msg += ":";
  msg += row;
  msg += ":";
  msg += action;
  msg += ":";
  msg += status;
  sendToESP32(msg);
}

void sendLoadingZoneUpdate(bool occupied) {
  String msg = "LOADING_ZONE:";
  msg += occupied ? "OCCUPIED" : "EMPTY";
  sendToESP32(msg);
}

void sendCellStatusUpdate(int row, int col, bool occupied) {
  String msg = "CELL_STATUS:";
  msg += row;
  msg += ":";
  msg += col;
  msg += ":";
  msg += occupied ? "1" : "0";
  sendToESP32(msg);
}

void sendAllCellStatus() {
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {
      sendCellStatusUpdate(row + 1, col + 1, cellOccupied[row][col]);
    }
  }
}

void sendSensorUpdate() {
  bool ldr1 = readLDRStable(LDR1_PIN, ldr1Baseline);
  bool ldr2 = readLDRStable(LDR2_PIN, ldr2Baseline);

  // Format:
  // SENSOR:<ldr1>,<ldr2>,<rfid>,<convState>[,<loadingZoneOccupied>]
  String sensorData = "SENSOR:";
  sensorData += ldr1 ? "1" : "0";
  sensorData += ",";
  sensorData += ldr2 ? "1" : "0";
  sensorData += ",";
  sensorData += currentRFID;
  sensorData += ",";
  sensorData += String((int)convState);
  sensorData += ",";
  sensorData += (loadingZoneOccupied ? "1" : "0");

  sendToESP32(sensorData);
}

// ============================
//   CONVEYOR MOTOR CONTROL (FROM FIRST CODE)
// ============================
void enableConveyorMotor(bool enable) {
  if (CONV_EN_ACTIVE_LOW) {
    digitalWrite(CONV_EN_PIN, enable ? LOW : HIGH);
  } else {
    digitalWrite(CONV_EN_PIN, enable ? HIGH : LOW);
  }
}

void setupConveyorStepper() {
  pinMode(CONV_EN_PIN, OUTPUT);
  pinMode(LDR1_PIN, LDR_USE_PULLUP ? INPUT_PULLUP : INPUT);
  pinMode(LDR2_PIN, LDR_USE_PULLUP ? INPUT_PULLUP : INPUT);

  delay(200);
  ldr1Baseline = calibrateBaseline(LDR1_PIN, 25, 2);
  ldr2Baseline = calibrateBaseline(LDR2_PIN, 25, 2);

enableConveyorMotor(false);

  conveyorStepper.setMaxSpeed(CONV_STEPPER_MAX_SPEED);
  conveyorStepper.setAcceleration(CONV_STEPPER_ACCEL);
  conveyorStepper.setCurrentPosition(0);
}

// ============================
//       ARM FUNCTIONS
// ============================
inline void stepPulse(int delayUs) {
  digitalWrite(ARM_STEP_PIN, HIGH);
  delayMicroseconds(delayUs);
  digitalWrite(ARM_STEP_PIN, LOW);
  delayMicroseconds(delayUs);
}

inline bool isHomeHit() {
  return (digitalRead(LIMIT_SWITCH_PIN) == LOW);
}

inline int lerpDelay(int startUs, int minUs, long i, long rampSteps) {
  long num = (long)(startUs - minUs) * i;
  long result = startUs - (num / rampSteps);
  return (result < minUs ? minUs : result);
}

int findTagIndex(const String &tag) {
  for (int i = 0; i < NUM_TAGS; i++) {
    if (tag == TAG_IDS[i]) return i;
  }
  return -1;
}

void moveStepsTrapezoid(long totalSteps, bool dir) {
  if (totalSteps <= 0) return;

  digitalWrite(ARM_DIR_PIN, dir);

  long rampSteps = totalSteps * TRAP_RAMP_FRACTION;
  if (rampSteps < 50) rampSteps = 50;
  if (2 * rampSteps > totalSteps) rampSteps = totalSteps / 2;
  long cruiseSteps = totalSteps - 2 * rampSteps;

  for (long i = 0; i < rampSteps; i++) {
    stepPulse(lerpDelay(TRAP_DELAY_START_US, TRAP_DELAY_MIN_US, i, rampSteps));
  }
  for (long i = 0; i < cruiseSteps; i++) {
    stepPulse(TRAP_DELAY_MIN_US);
  }
  for (long i = rampSteps; i > 0; i--) {
    stepPulse(lerpDelay(TRAP_DELAY_START_US, TRAP_DELAY_MIN_US, i - 1, rampSteps));
  }

  if (dir == DIR_AWAY_FROM_HOME) currentStepPos += totalSteps;
  else currentStepPos -= totalSteps;
}

void homeArm() {
  Serial.println("Homing arm...");
  lcdStatus("CMD: HOME", "Homing arm...");
  sendStatusUpdate("HOMING");

  returnToDefaultPosition();

  digitalWrite(ARM_DIR_PIN, DIR_TOWARD_HOME);
  long safetyCounter = 0;
  while (!isHomeHit()) {
    stepPulse(1200);
    safetyCounter++;
    if (safetyCounter > 200000) {
      Serial.println("Homing safety timeout!");
      break;
    }
  }

  digitalWrite(ARM_DIR_PIN, DIR_AWAY_FROM_HOME);
  for (int i = 0; i < BACKOFF_STEPS; i++) stepPulse(1400);

  digitalWrite(ARM_DIR_PIN, DIR_TOWARD_HOME);
  while (!isHomeHit()) stepPulse(1600);

  digitalWrite(ARM_DIR_PIN, DIR_AWAY_FROM_HOME);
  for (int i = 0; i < 15; i++) stepPulse(1600);

  currentStepPos = 0;
  Serial.println("Arm homed.");
  lcdStatus("CMD: HOME", "Arm homed");
  sendStatusUpdate("HOME_COMPLETE");
}

void goToColumn(int col) {
  if (col < 1) col = 1;
  if (col > NUM_COLUMNS) col = NUM_COLUMNS;

  long targetSteps = (long)(COL_ABS_CM[col - 1] * STEPS_PER_CM);
  long moveSteps   = targetSteps - currentStepPos;
  bool dir         = (moveSteps >= 0) ? DIR_AWAY_FROM_HOME : DIR_TOWARD_HOME;

  Serial.print("Moving to column ");
  Serial.print(col);
  Serial.print(" -> steps: ");
  Serial.println(moveSteps);

  String line1 = "GOTO COL ";
  line1 += col;
  lcdStatus(line1, "Moving...");
  sendStatusUpdate("GOTO_COLUMN");

  moveStepsTrapezoid(labs(moveSteps), dir);
  sendStatusUpdate("GOTO_COMPLETE");
}

// ============================
//   SERVO CONTROL FUNCTIONS
// ============================
void servoSmooth(Servo &sv, int &curr, int target, float speed_dps = SERVO_SPEED_DPS_DEFAULT) {
  target = constrain(target, 0, 180);
  if (curr == target) return;

  float delayPerDeg = 1000.0f / speed_dps;
  int step = (target > curr) ? 1 : -1;

  while (curr != target) {
    curr += step;
    if ((step > 0 && curr > target) || (step < 0 && curr < target)) curr = target;
    sv.write(curr);
    delay(delayPerDeg);
  }
}



void returnToDefaultPosition() {
  Serial.println("Returning to default position...");
  
  const int SHORT_DELAY = 250;
  const int S5_DELAY    = 400;
  if (!gripperHolding) {
    servoSmooth(s1, s1Pos, 60);
  }
  delay(SHORT_DELAY);

  servoSmooth(s2, s2Pos, 130);
  delay(SHORT_DELAY);

  servoSmooth(s5, s5Pos, 10);
  delay(S5_DELAY);

  servoSmooth(s4, s4Pos, 100);
  delay(SHORT_DELAY);

  servoSmooth(s6, s6Pos, 65);
  delay(SHORT_DELAY);

  servoSmooth(s3, s3Pos, 90);
  delay(SHORT_DELAY);
}

void goToLoadingZonePose() {
  lcdStatus("LOADING ZONE", "Moving...");
  sendStatusUpdate("RETURN_TO_LOADING");
  
  const int D = 300;

  servoSmooth(s6, s6Pos, 90);
  delay(D);

  servoSmooth(s5, s5Pos, 120);
  delay(D);
  servoSmooth(s6, s6Pos, 75);
  delay(D);
  servoSmooth(s2, s2Pos, 60);
  delay(D);

  servoSmooth(s1, s1Pos, 145);
  delay(D);

  servoSmooth(s6, s6Pos, 90);
  delay(D);
  servoSmooth(s5, s5Pos, 50);
  delay(D);

  servoSmooth(s6, s6Pos, 90);
  delay(D);
  returnToDefaultPosition();
}

void goToLoadingZonePlacePose() {
lcdStatus("LOADING ZONE place ", "Moving...");
  sendStatusUpdate("RETURN_TO_LOADING");
    returnToDefaultPosition();

  const int D = 300;

  servoSmooth(s6, s6Pos, 90);
  delay(D);
  servoSmooth(s5, s5Pos, 100);
  delay(D);
  servoSmooth(s6, s6Pos, 75);
  delay(D);
  servoSmooth(s4, s4Pos, 90);
  delay(D);
  servoSmooth(s2, s2Pos, 60);
  delay(D);
  servoSmooth(s5, s5Pos, 120);
  delay(D);
  servoSmooth(s6, s6Pos, 70);
  delay(D);
  servoSmooth(s1, s1Pos, 160);
  delay(D);
  servoSmooth(s5, s5Pos, 90);
  delay(D);
  servoSmooth(s6, s6Pos, 90);
  delay(D);
  servoSmooth(s5, s5Pos, 50);
  delay(D);
  returnToDefaultPosition();
}
void goToLoadingZoneTakePose() {
lcdStatus("LOADING ZONE take ", "Moving...");
  sendStatusUpdate("RETURN_TO_LOADING");
    returnToDefaultPosition();

 const int D = 300;
  servoSmooth(s1, s1Pos, 160);
  delay(D);
  servoSmooth(s6, s6Pos, 90);
  delay(D);
  servoSmooth(s5, s5Pos, 100);
  delay(D);
  servoSmooth(s6, s6Pos, 75);
  delay(D);
  servoSmooth(s4, s4Pos, 90);
  delay(D);
  servoSmooth(s2, s2Pos, 60);
  delay(D);
  servoSmooth(s5, s5Pos, 120);
  delay(D);
  servoSmooth(s6, s6Pos, 70);
  delay(D);
  servoSmooth(s1, s1Pos, 30);
  delay(D);
  servoSmooth(s6, s6Pos, 90);
  delay(D);
  servoSmooth(s5, s5Pos, 50);
  delay(D);
  returnToDefaultPosition();
  }


void openLoadingZone() {
  servoSmooth(loadingServo, loadingServoPos, 180);
  delay(300);
}

void closeLoadingZone() {
  servoSmooth(loadingServo, loadingServoPos, 90);
  delay(300);
}

void operateLoadingZone(bool open) {
  if (open) {
    openLoadingZone();
    sendStatusUpdate("LOADING_ZONE_OPEN");
  } else {
    closeLoadingZone();
    sendStatusUpdate("LOADING_ZONE_CLOSED");
  }
}

void moveServosToPickupFromConveyor() {
  lcdStatus("PICK", "From conveyor");
  sendStatusUpdate("PICKING_FROM_CONVEYOR");
  
  servoSmooth(s6, s6Pos, 131);
  servoSmooth(s2, s2Pos, 55);
  servoSmooth(s1, s1Pos, 170); 
  servoSmooth(s4, s4Pos, 50);
  servoSmooth(s5, s5Pos, 80);
  servoSmooth(s4, s4Pos, 60);
  servoSmooth(s5, s5Pos, 90);
  delay(500);

  servoSmooth(s1, s1Pos, 20); 
  servoSmooth(s5, s5Pos, 10);
  servoSmooth(s2, s2Pos, 120);
  servoSmooth(s6, s6Pos, 60);
  servoSmooth(s4, s4Pos, 110);

  gripperHolding = true;
    
  sendStatusUpdate("PICK_FROM_CONVEYOR_COMPLETE");
  returnToDefaultPosition();
}

// ============================
//   PLACE ROW FUNCTIONS
// ============================
void placeInRow1() {
  int d=300;
  servoSmooth(s2, s2Pos, 110);
  delay(d);
  servoSmooth(s5, s5Pos, 75);
  delay(d);
  servoSmooth(s4, s4Pos, 85);
  delay(d);  
  servoSmooth(s1, s1Pos, 140);
  delay(d);
  servoSmooth(s4, s4Pos, 110);
  delay(d);
    servoSmooth(s5, s5Pos, 40);
  delay(d);

  servoSmooth(s2, s2Pos, 120);
  delay(d);
  
  returnToDefaultPosition();
}

void placeInRow2() {
  int d=300;
  servoSmooth(s4, s4Pos, 40);
  delay(d);
  servoSmooth(s2, s2Pos, 140);
  delay(d);
  servoSmooth(s5, s5Pos, 40);
  delay(d);
  servoSmooth(s2, s2Pos, 100);
  delay(d);
  servoSmooth(s4, s4Pos, 20);
  delay(d);
  servoSmooth(s2, s2Pos, 60);
  delay(d);
   servoSmooth(s5, s5Pos, 60);
  delay(d);
  servoSmooth(s1, s1Pos, 160);
  delay(d);
 

  servoSmooth(s1, s1Pos, 120);
  delay(d);
  servoSmooth(s5, s5Pos, 30);
  delay(d);
  servoSmooth(s2, s2Pos, 100);
  delay(d);
  servoSmooth(s5, s5Pos, 0);
  delay(d);
  servoSmooth(s4, s4Pos, 100);
  delay(d);
  
  returnToDefaultPosition();
}

void placeInRow3() {
  int d=300;
  servoSmooth(s5, s5Pos, 0);
  delay(d);
  servoSmooth(s4, s4Pos, 0);
  delay(d);
  servoSmooth(s5, s5Pos, 30);
  delay(d);
  servoSmooth(s2, s2Pos, 100);
  delay(d);
  servoSmooth(s5, s5Pos, 60);
  delay(d);
  servoSmooth(s2, s2Pos, 60);
  delay(d);
  servoSmooth(s5, s5Pos, 75);
  delay(d);
  servoSmooth(s2, s2Pos, 20);
  delay(d);
  servoSmooth(s5, s5Pos, 80);
  delay(d);
  servoSmooth(s4, s4Pos, 5);
  delay(d);
  servoSmooth(s2, s2Pos, 10);
  delay(d);
  servoSmooth(s5, s5Pos, 100);
  delay(d);
  servoSmooth(s4, s4Pos, 15);
  delay(d);
  servoSmooth(s1, s1Pos, 140); 
  delay(d);

  servoSmooth(s4, s4Pos, 0);
  delay(d);
  servoSmooth(s5, s5Pos, 70);
  delay(d);
  servoSmooth(s2, s2Pos, 80);
  delay(d);
  servoSmooth(s5, s5Pos, 40);
  delay(d);
  
  returnToDefaultPosition();
}

// ============================
//   PICK FROM CELL FUNCTIONS
// ============================
void pickFromRow1() {
   int d=300;
  servoSmooth(s1, s1Pos, 110);
  delay(d);
  servoSmooth(s2, s2Pos, 95);
  delay(d);
  servoSmooth(s5, s5Pos, 65);
  delay(d);
  servoSmooth(s4, s4Pos, 90);
  delay(d); 
    servoSmooth(s1, s1Pos, 0);
  delay(d); 
  servoSmooth(s2, s2Pos, 140);
  delay(d);
    servoSmooth(s4, s4Pos, 110);
  delay(d);
  servoSmooth(s5, s5Pos, 20);
  delay(d);  
  returnToDefaultPosition();
}

void pickFromRow2() {
   int d=300;
     servoSmooth(s1, s1Pos, 160);
  servoSmooth(s4, s4Pos, 40);
  delay(d);
  servoSmooth(s2, s2Pos, 140);
  delay(d);
  servoSmooth(s5, s5Pos, 40);
  delay(d);
  servoSmooth(s2, s2Pos, 100);
  delay(d);
  servoSmooth(s4, s4Pos, 20);
  delay(d);
  servoSmooth(s2, s2Pos, 50);
  delay(d);
   servoSmooth(s5, s5Pos, 70);
  delay(d);
  servoSmooth(s1, s1Pos, 30);
  delay(d);
 

  servoSmooth(s5, s5Pos, 30);
  delay(d);
  servoSmooth(s2, s2Pos, 120);
  delay(d);
  servoSmooth(s5, s5Pos, 10);
  delay(d);
  servoSmooth(s4, s4Pos, 95);
  delay(d);
    returnToDefaultPosition();

  
}

void pickFromRow3() {
   int d=300;
  servoSmooth(s1, s1Pos, 120); 
  delay(d);
  servoSmooth(s5, s5Pos, 0);
  delay(d);
  servoSmooth(s4, s4Pos, 0);
  delay(d);
  servoSmooth(s5, s5Pos, 30);
  delay(d);
  servoSmooth(s2, s2Pos, 100);
  delay(d);
  servoSmooth(s5, s5Pos, 60);
  delay(d);
  servoSmooth(s2, s2Pos, 60);
  delay(d);
  servoSmooth(s5, s5Pos, 75);
  delay(d);
  servoSmooth(s2, s2Pos, 20);
  delay(d);
  servoSmooth(s5, s5Pos, 80);
  delay(d);
  servoSmooth(s4, s4Pos, 5);
  delay(d);
  servoSmooth(s2, s2Pos, 10);
  delay(d);
  servoSmooth(s5, s5Pos, 100);
  delay(d);
  servoSmooth(s4, s4Pos, 15);
  delay(d);
  servoSmooth(s1, s1Pos, 30); 
  delay(d);

  servoSmooth(s4, s4Pos, 0);
  delay(d);
  servoSmooth(s5, s5Pos, 70);
  delay(d);
  servoSmooth(s2, s2Pos, 80);
  delay(d);
  servoSmooth(s5, s5Pos, 40);
  delay(d);
    returnToDefaultPosition();

  
}
void placeInRow_thenRetract(int row) {
  String line1 = "PLACE R";
  line1 += row;
  lcdStatus(line1, "Placing...");
  sendStatusUpdate("PLACING");
  gripperHolding = false;

  switch (row) {
    case 1: placeInRow1(); break;
    case 2: placeInRow2(); break;
    case 3: placeInRow3(); break;
    default:
      Serial.println("Invalid row (1..3).");
      lcdStatus("ERROR", "Row invalid");
      sendStatusUpdate("PLACE_ERROR");
      return;
  }

  if (targetCol >= 1 && targetRow >= 1) {
    cellOccupied[targetRow - 1][targetCol - 1] = true;
    sendCellUpdate(targetCol, targetRow, "PLACED", "OCCUPIED");
    sendCellStatusUpdate(targetRow, targetCol, true);
  }

  returnToDefaultPosition();
  sendStatusUpdate("PLACE_COMPLETE");
}

void pickFromRow_thenRetract(int row) {
  String line1 = "TAKE R";
  line1 += row;
  lcdStatus(line1, "Picking...");
  sendStatusUpdate("PICK_FROM_CELL");

  gripperHolding = true;

  switch (row) {
    case 1: pickFromRow1(); break;
    case 2: pickFromRow2(); break;
    case 3: pickFromRow3(); break;
    default:
      Serial.println("Invalid row (1..3) in pick.");
      lcdStatus("ERROR", "Row invalid");
      sendStatusUpdate("PICK_FROM_CELL_ERR");
      return;
  }

  if (targetCol >= 1 && targetRow >= 1) {
    cellOccupied[targetRow - 1][targetCol - 1] = false;
    sendCellUpdate(targetCol, targetRow, "TAKEN", "EMPTY");
    sendCellStatusUpdate(targetRow, targetCol, false);
  }

  returnToDefaultPosition();
  sendStatusUpdate("PICK_FROM_CELL_DONE");
}

// ============================
//       RFID HELPERS
// ============================
String uidToString(const byte* uid, uint8_t len) {
  String s;
  for (uint8_t i = 0; i < len; i++) {
    if (i) s += ".";
    s += String(uid[i]);
  }
  return s;
}

bool tryReadRFID(String &outStr) {
  byte uid[7];
  uint8_t uidLength;
  bool success = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 100);
  if (!success) return false;
  outStr = uidToString(uid, uidLength);
  return true;
}

// ============================
//   IR SENSOR FUNCTIONS
// ============================
void setupIRSensors() {
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {
      pinMode(IR_PINS[row][col], IR_USE_PULLUP ? INPUT_PULLUP : INPUT);
    }
  }

  delay(250);
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {
      irBaseline[row][col] = calibrateBaseline(IR_PINS[row][col], 25, 2);
    }
  }
}

bool readIRRaw(uint8_t pin, uint8_t baselineLevel) {
  int raw = digitalRead(pin);
  return (raw != baselineLevel);
}
void sendIRGridUpdate() {
    String gridMsg = "IR_GRID:";
    for (int r = 0; r < 3; r++) {
        for (int c = 0; c < 4; c++) {
            gridMsg += String(cellOccupied[r][c] ? "1" : "0");
            if (!(r == 2 && c == 3)) gridMsg += ",";
        }
    }
    sendToESP32(gridMsg);
}

static unsigned long lastIRGridUpdate = 0;


uint8_t calibrateBaseline(uint8_t pin, uint8_t samples = 25, uint8_t sampleDelayMs = 2) {
  uint8_t highs = 0;
  for (uint8_t i = 0; i < samples; i++) {
    if (digitalRead(pin) == HIGH) highs++;
    delay(sampleDelayMs);
  }
  return (highs >= (samples / 2 + 1)) ? HIGH : LOW;
}

// Sample عدة مرات عشان نتجاهل الوميض اللحظي
bool readIRStable(uint8_t pin, uint8_t baselineLevel) {
  uint8_t hits = 0;
  for (uint8_t i = 0; i < IR_SAMPLES; i++) {
    if (readIRRaw(pin, baselineLevel)) hits++;
    delay(IR_SAMPLE_DELAY_MS);
  }
  return hits >= IR_MAJORITY;
}

void updateCellOccupancyFromSensors() {


  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {

      bool sensed = readIRStable(IR_PINS[row][col], irBaseline[row][col]);

      // لو نفس الحالة الحالية، صفّر العدّاد
      if (sensed == cellSensor[row][col]) {
        irCount[row][col] = 0;
        irCandidate[row][col] = sensed;
        continue;
      }

      // Candidate / counter
      if (irCandidate[row][col] == sensed) {
        if (irCount[row][col] < 250) irCount[row][col]++;
      } else {
        irCandidate[row][col] = sensed;
        irCount[row][col] = 1;
      }

      const bool current = cellSensor[row][col];
      const uint8_t needN = current ? IR_CLEAR_CONFIRM_N : IR_CONFIRM_N;
      const uint16_t needMs = current ? IR_CLEAR_MIN_CHANGE_MS : IR_MIN_CHANGE_MS;

      unsigned long now = millis();
      if (irCount[row][col] >= needN && (now - irLastChangeMs[row][col] >= needMs)) {
        cellSensor[row][col] = sensed;
        cellOccupied[row][col] = sensed; // ✅ مهم: خلي الـ grid (اللي بنبعته) نفس الحالة المستقرة
        irLastChangeMs[row][col] = now;
        irCount[row][col] = 0;

        // ابعث CELL_STATUS (الـ ESP32 فاهمها)
        sendCellStatusUpdate(row + 1, col + 1, sensed);
      }
    }
  }
}




// ============================
//   ULTRASONIC FUNCTIONS
// ============================
long ultraReadOnceCM() {
  digitalWrite(ULTRA_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRA_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRA_TRIG, LOW);

  long duration = pulseIn(ULTRA_ECHO, HIGH, 30000);
  if (duration == 0) return -1;

  long cm = (long)(duration * 0.034 / 2.0);
  if (cm < 1 || cm > 400) return -1;
  return cm;
}

long ultraReadFilteredCM() {
  long best = 100000;
  int valid = 0;

  for (int i = 0; i < 2; i++) {
    long cm = ultraReadOnceCM();
    if (cm > 0) {
      valid++;
      if (cm < best) best = cm; 
    }
    delay(10);
  }

  if (valid == 0) return -1;
  return best;
}


long scanMinDistanceCM() {
  long minCm = 100000;

  // Center
  servoSmooth(loadingServo, loadingServoPos, SCAN_CENTER);
  delay(SERVO_SETTLE_MS);
  long c = ultraReadFilteredCM();
  if (c > 0 && c < minCm) minCm = c;

  // Left
  servoSmooth(loadingServo, loadingServoPos, SCAN_LEFT);
  delay(SERVO_SETTLE_MS);
  long l = ultraReadFilteredCM();
  if (l > 0 && l < minCm) minCm = l;

  // Right
  servoSmooth(loadingServo, loadingServoPos, SCAN_RIGHT);
  delay(SERVO_SETTLE_MS);
  long r = ultraReadFilteredCM();
  if (r > 0 && r < minCm) minCm = r;

  // رجّع للوسط
  servoSmooth(loadingServo, loadingServoPos, SCAN_CENTER);
  delay(80);

  if (minCm == 100000) return -1;
  return minCm;
}


bool checkLoadingZoneOccupied() {
  bool prev = loadingZoneOccupied;
  long cm = lastScanMinCm;

  bool desired = loadingZoneOccupied;

  if (cm > 0 && cm <= LZ_OCCUPIED_CM) {
    desired = true;
  } else if (cm < 0 || cm > LZ_EMPTY_CM) {
    desired = false;
  }

  if (desired != loadingZoneOccupied) {
    lzConfirmCounter++;
    if (lzConfirmCounter >= LZ_CONFIRM_N) {
      loadingZoneOccupied = desired;
      lzConfirmCounter = 0;
    }
  } else {
    lzConfirmCounter = 0;
  }

  // Notify ESP32 only when the loading zone occupancy changes
  if (prev != loadingZoneOccupied) {
    String msg = "LZ:";
    msg += (loadingZoneOccupied ? "1" : "0");
    sendToESP32(msg);
  }

  // Debug (اختياري)
  Serial.print("[LZ] cm=");
  Serial.print(cm);
  Serial.print(" state=");
  Serial.println(loadingZoneOccupied ? "OCCUPIED" : "EMPTY");

  return loadingZoneOccupied;
}

// ============================
//   STORAGE STRATEGY FUNCTIONS
bool getCellFromStrategy(int &col, int &row, String rfid = "") {
  
  Serial.print("[DEBUG] getCellFromStrategy called with RFID: ");
  Serial.println(rfid);
  Serial.print("[DEBUG] Current strategy: ");
  Serial.println(currentStorageStrategy);
  
  const char* fixedRFIDmap[3][4] = {
    {"12.80.110.3",      "", "204.187.101.3", ""},
    {"66.208.30.83",     "",     "",              "252.53.92.3"},
    {"12.86.101.3",                 "",                "178.139.221.208",              ""}
  };
  
  switch (currentStorageStrategy) {
    case STRATEGY_NEAREST_EMPTY:
      // البحث من R1C1 إلى R3C4
      for (int r = 0; r < 3; r++) {
        for (int c = 0; c < 4; c++) {
          if (!cellOccupied[r][c]) {
            row = r + 1;
            col = c + 1;
            Serial.print("[NEAREST] Selected R");
            Serial.print(row);
            Serial.print(" C");
            Serial.println(col);
            return true;
          }
        }
      }
      break;

    case STRATEGY_AI_OPTIMIZED:
      {
        int startR = 1; // الصف الثاني (الأوسط)
        int startC = 2; // العمود الثالث (الأوسط تقريباً)
        
        int bestDist = 100;
        int bestRow = -1, bestCol = -1;
        
        for (int r = 0; r < 3; r++) {
          for (int c = 0; c < 4; c++) {
            if (!cellOccupied[r][c]) {
              int dist = abs(r - startR) + abs(c - startC);
              if (dist < bestDist) {
                bestDist = dist;
                bestRow = r;
                bestCol = c;
              }
            }
          }
        }
        
        if (bestRow != -1) {
          row = bestRow + 1;
          col = bestCol + 1;
          Serial.print("[AI] Selected R");
          Serial.print(row);
          Serial.print(" C");
          Serial.println(col);
          return true;
        }
      }
      break;

    case STRATEGY_FIXED:
      if (rfid.length() > 0) {
        for (int r = 0; r < 3; r++) {
          for (int c = 0; c < 4; c++) {
            if (String(fixedRFIDmap[r][c]) == rfid) {
              if (!cellOccupied[r][c]) {
                row = r + 1;
                col = c + 1;
                Serial.print("[FIXED] Selected R");
                Serial.print(row);
                Serial.print(" C");
                Serial.println(col);
                return true;
              } else {
                Serial.print("[FIXED] WARNING: Cell R");
                Serial.print(r+1);
                Serial.print(" C");
                Serial.print(c+1);
                Serial.println(" is occupied! (ABORT - no fallback)");
                return false; // ✅ ممنوع fallback في FIXED
              }
            }
          }
        }
        Serial.println("[FIXED] RFID not in map (ABORT - no fallback)");
        return false; // ✅ ممنوع fallback في FIXED
      }
      Serial.println("[FIXED] No RFID provided to strategy (ABORT - no fallback)");
      return false; // ✅ لازم يكون في RFID
      break;
  }
  
  Serial.println("[ERROR] No empty cells found!");
  return false;
}
// ============================
//   AUTO TASK MANAGEMENT
// ============================
void addAutoTask(String command, String rfid = "", int col = -1, int row = -1) {
  if (autoTaskCount >= 10) {
    Serial.println("Auto task queue full!");
    return;
  }

  autoTasks[autoTaskCount].command = command;
  autoTasks[autoTaskCount].rfid = rfid;
  autoTasks[autoTaskCount].col = col;
  autoTasks[autoTaskCount].row = row;
  autoTasks[autoTaskCount].pending = true;

  Serial.print("Added auto task: ");
  Serial.println(command);

  autoTaskCount++;
}

void processNextAutoTask() {
  if (currentTaskIndex >= 0 && currentTaskIndex < autoTaskCount) return;

  for (int i = 0; i < autoTaskCount; i++) {
    if (autoTasks[i].pending) {
      currentTaskIndex = i;
      AutoTask task = autoTasks[i];

      Serial.print("Processing auto task ");
      Serial.print(i);
      Serial.print(": ");
      Serial.println(task.command);

      lcdStatus("AUTO TASK", task.command);

      if (task.command == "AUTO_STOCK") {
        if (task.rfid.length() > 0) {
          String cmd = "AUTO_STOCK:" + task.rfid;
          handleCommand(cmd);
        }
      } else if (task.command == "PLACE") {
        if (task.col > 0 && task.row > 0) {
          String cmd = "PLACE " + String(task.col) + " " + String(task.row);
          handleCommand(cmd);
        }
      } else if (task.command == "TAKE") {
        if (task.col > 0 && task.row > 0) {
          String cmd = "TAKE " + String(task.col) + " " + String(task.row);
          handleCommand(cmd);
        }
      } else {
        handleCommand(task.command);
      }

      autoTasks[i].pending = false;

      currentTaskIndex = -1;
      break;
    }
  }
}

// ============================
//       COMMAND HANDLER
// ============================
String readCommand(Stream &s) {
  s.setTimeout(500);
  String cmd = s.readStringUntil('\n');
  cmd.trim();
  cmd.toUpperCase();
  return cmd;
}

void handleCommand(String cmd) {
  if (cmd.length() == 0) return;

  Serial.print("CMD RECEIVED: ");
  Serial.println(cmd);

  sendToESP32("CMD_RECEIVED:" + cmd);

  // ===== STORAGE STRATEGY COMMANDS =====
  if (cmd == "STRATEGY NEAREST") {
    currentStorageStrategy = STRATEGY_NEAREST_EMPTY;
    lcdStatus("STRATEGY", "Nearest Empty");
    sendToESP32("STRATEGY:NEAREST_EMPTY");
    return;
  }

  if (cmd == "STRATEGY AI") {
    currentStorageStrategy = STRATEGY_AI_OPTIMIZED;
    lcdStatus("STRATEGY", "AI Optimized");
    sendToESP32("STRATEGY:AI_OPTIMIZED");
    return;
  }

  if (cmd == "STRATEGY FIXED") {
    currentStorageStrategy = STRATEGY_FIXED;
    lcdStatus("STRATEGY", "Fixed Mapping");
    sendToESP32("STRATEGY:FIXED");
    return;
  }

  if (cmd == "SET_FIXED_MAP") {
    lcdStatus("SET FIXED MAP", "Not Implemented");
    sendToESP32("SET_FIXED_MAP:ACK");
    return;
  }
if (cmd.startsWith("STOCK_QTY:")) {
    int colon1 = cmd.indexOf(':');
    int colon2 = cmd.indexOf(':', colon1 + 1);
    
    if (colon1 > 0 && colon2 > 0) {
        int qty = cmd.substring(colon1 + 1, colon2).toInt();
        String rfid = cmd.substring(colon2 + 1);
        
        lcdStatus("STOCK QTY:", String(qty) + " items");
        sendToESP32("TASK:STOCK_QTY:" + String(qty) + ":" + rfid);
        
        for (int i = 0; i < qty; i++) {
            if (i > 0) {
                lcdStatus("Waiting", "For next item...");
                // انتظار حتى يخلو الكونفيور
                while (readLDRStable(LDR1_PIN, ldr1Baseline)) {
                    delay(500);
                }
            }
            
            // تنفيذ تخزين منتج واحد
            String stockCmd = rfid.length() > 0 ? "AUTO_STOCK:" + rfid : "AUTO_STOCK";
            handleCommand(stockCmd);
            
            // انتظار بين المنتجات
            if (i < qty - 1) {
                delay(3000);
            }
        }
        
        sendToESP32("STOCK_QTY_COMPLETE:" + String(qty));
    }
    return;
}

// أمر ترتيب المستودع (صف صف)
if (cmd == "REORGANIZE_WAREHOUSE") {
    lcdStatus("REORGANIZE", "Smart fill rows");
    sendToESP32("STATUS:REORGANIZING");
    
    // 1. جمع معلومات الخلايا المشغولة
    struct CellInfo {
        int row, col;
        bool occupied;
        String rfid;
    };
    
    CellInfo occupiedCells[12];
    int occupiedCount = 0;
    
    // البحث عن الخلايا المشغولة مع حفظ RFID
    for (int r = 0; r < 3; r++) {
        for (int c = 0; c < 4; c++) {
            if (cellOccupied[r][c]) {
                occupiedCells[occupiedCount].row = r + 1;
                occupiedCells[occupiedCount].col = c + 1;
                occupiedCells[occupiedCount].occupied = true;
                occupiedCells[occupiedCount].rfid = rfidCellMap[r][c];
                occupiedCount++;
            }
        }
    }
    
    // 2. ترتيب الخلايا حسب البعد عن R1C1 (صف صف)
    for (int i = 0; i < occupiedCount - 1; i++) {
        for (int j = i + 1; j < occupiedCount; j++) {
            int dist_i = (occupiedCells[i].row - 1) * 4 + occupiedCells[i].col;
            int dist_j = (occupiedCells[j].row - 1) * 4 + occupiedCells[j].col;
            if (dist_i > dist_j) {
                CellInfo temp = occupiedCells[i];
                occupiedCells[i] = occupiedCells[j];
                occupiedCells[j] = temp;
            }
        }
    }
    
    // 3. إعادة الترتيب
    int currentPos = 0;
    for (int r = 1; r <= 3; r++) {
        for (int c = 1; c <= 4; c++) {
            if (currentPos < occupiedCount) {
                // إذا كانت الخلية الحالية فارغة والمنتج ليس في مكانه الصحيح
                if (!cellOccupied[r-1][c-1] && 
                    (occupiedCells[currentPos].row != r || occupiedCells[currentPos].col != c)) {
                    
                    // أخذ من الخلية القديمة
                    goToColumn(occupiedCells[currentPos].col);
                    pickFromRow_thenRetract(occupiedCells[currentPos].row);
                    
                    // وضع في الخلية الجديدة
                    goToColumn(c);
                    placeInRow_thenRetract(r);
                    
                    // تحديث حالة الخلايا
                    cellOccupied[occupiedCells[currentPos].row-1][occupiedCells[currentPos].col-1] = false;
                    cellOccupied[r-1][c-1] = true;
                    
                    // تحديث الـ RFID map
                    rfidCellMap[r-1][c-1] = occupiedCells[currentPos].rfid;
                    rfidCellMap[occupiedCells[currentPos].row-1][occupiedCells[currentPos].col-1] = "";
                    
                    // إرسال تحديثات الحالة
                    sendCellStatusUpdate(occupiedCells[currentPos].row, occupiedCells[currentPos].col, false);
                    sendCellStatusUpdate(r, c, true);
                    
                    // انتظار بين العمليات
                    delay(2000);
                }
                currentPos++;
            }
        }
    }
    
    homeArm();
    sendToESP32("STATUS:REORGANIZE_COMPLETE");
    return;
}




if (cmd.startsWith("LOADING_PLACE")) {
    // format: LOADING_PLACE col row
    String params = cmd.substring(String("LOADING_PLACE").length());
    params.trim();
    int sp = params.indexOf(' ');
    if (sp > 0) {
      int col = params.substring(0, sp).toInt();
      int row = params.substring(sp + 1).toInt();

      if (col < 1 || col > 4 || row < 1 || row > 3) {
        sendToESP32("STATUS:LOADING_PLACE_ERROR:BAD_CELL");
        return;
      }

      if (loadingZoneOccupied) {
        lcdStatus("LOADING OCC", "Cannot place");
        sendToESP32("STATUS:LOADING_PLACE_ERROR:LOADING_OCCUPIED");
        return;
      }

      if (!cellOccupied[row-1][col-1]) {
        lcdStatus("CELL EMPTY", "Cannot take");
        sendToESP32("STATUS:LOADING_PLACE_ERROR:CELL_EMPTY");
        return;
      }

      lcdStatus("PLACE->LOADING", String("C") + col + " R" + row);
      sendToESP32("STATUS:LOADING_PLACE_START");

      // Pick from cell
      goToColumn(col);
      pickFromRow_thenRetract(row);
      homeArm();
      returnToDefaultPosition();

      // Move to loading zone with the dedicated pose
      goToLoadingZonePlacePose();

      // Update maps
      cellOccupied[row-1][col-1] = false;
      sendCellStatusUpdate(row, col, false);

      loadingZoneOccupied = true;
      sendLoadingZoneUpdate(true);

      String rfid = rfidCellMap[row-1][col-1];
      rfidCellMap[row-1][col-1] = "";
      if (rfid.length() > 0) {
        sendToESP32("PRODUCT_IN_LOADING:" + rfid);
      }

      sendToESP32("STATUS:LOADING_PLACE_COMPLETE");
      homeArm();
    }
    return;
}

// NEW: manual button (TAKE FROM LOADING) with its own pose
if (cmd.startsWith("LOADING_TAKE")) {
    // format: LOADING_TAKE col row (target)
    String params = cmd.substring(String("LOADING_TAKE").length());
    params.trim();
    int sp = params.indexOf(' ');
    if (sp > 0) {
      int col = params.substring(0, sp).toInt();
      int row = params.substring(sp + 1).toInt();

      if (col < 1 || col > 4 || row < 1 || row > 3) {
        sendToESP32("STATUS:LOADING_TAKE_ERROR:BAD_CELL");
        return;
      }

      if (!loadingZoneOccupied) {
        lcdStatus("LOADING EMPTY", "Cannot take");
        sendToESP32("STATUS:LOADING_TAKE_ERROR:LOADING_EMPTY");
        return;
      }

      if (cellOccupied[row-1][col-1]) {
        lcdStatus("TARGET OCC", "Denied");
        sendToESP32("STATUS:LOADING_TAKE_ERROR:TARGET_OCCUPIED");
        return;
      }

      lcdStatus("TAKE<-LOADING", String("C") + col + " R" + row);
      sendToESP32("STATUS:LOADING_TAKE_START");

      // Go to loading zone with the dedicated pose
      goToLoadingZoneTakePose();
      closeLoadingZone();
      delay(300);

      // Place into target
      goToColumn(col);
      placeInRow_thenRetract(row);

      cellOccupied[row-1][col-1] = true;
      sendCellStatusUpdate(row, col, true);

      loadingZoneOccupied = false;
      sendLoadingZoneUpdate(false);

      sendToESP32("STATUS:LOADING_TAKE_COMPLETE");
      homeArm();
    }
    return;
}


// أمر نقل من خلية إلى loading zone
if (cmd.startsWith("MOVE_TO_LOADING:")) {
    String params = cmd.substring(16);
    int spaceIdx = params.indexOf(' ');
    if (spaceIdx > 0) {
        int col = params.substring(0, spaceIdx).toInt();
        int row = params.substring(spaceIdx + 1).toInt();
        
        lcdStatus("MOVE TO LOADING", 
            String("C") + col + " R" + row);
        sendToESP32("TASK:MOVE_TO_LOADING:" + String(col) + ":" + String(row));
        
        // 1. الذهاب للخلية وأخذ المنتج
        goToColumn(col);
        pickFromRow_thenRetract(row);
        
        // 2. الذهاب للـ loading zone
        goToLoadingZonePose();
        
        // 3. فتح loading zone
        openLoadingZone();
        delay(500);
        
        // 4. تحديث حالة الخلية
        cellOccupied[row-1][col-1] = false;
        sendCellStatusUpdate(row, col, false);
        
        // 5. تحديث حالة loading zone
        loadingZoneOccupied = true;
        sendLoadingZoneUpdate(true);
        
        // 6. حفظ RFID في loading zone
        String rfid = rfidCellMap[row-1][col-1];
        if (rfid.length() > 0) {
            sendToESP32("PRODUCT_IN_LOADING:" + rfid);
        }
        
        sendToESP32("STATUS:MOVE_TO_LOADING_COMPLETE");
    }
    return;
}

// أمر إرجاع من loading zone
if (cmd == "LOAD_RETURN") {
    lcdStatus("LOAD RETURN", "From loading zone");
    sendToESP32("STATUS:LOAD_RETURN_START");
    
    // 1. إغلاق loading zone
    closeLoadingZone();
    delay(500);
    
    // 2. البحث عن خلية فارغة
    int targetCol = -1, targetRow = -1;
    for (int r = 1; r <= 3; r++) {
        for (int c = 1; c <= 4; c++) {
            if (!cellOccupied[r-1][c-1]) {
                targetCol = c;
                targetRow = r;
                break;
            }
        }
        if (targetCol != -1) break;
    }
    
    if (targetCol != -1) {
        // 3. أخذ من loading zone
        goToLoadingZonePose();
        closeLoadingZone();
        delay(300);
        
        // 4. الذهاب للخلية ووضع المنتج
        goToColumn(targetCol);
        placeInRow_thenRetract(targetRow);
        
        // 5. تحديث حالة الخلية
        cellOccupied[targetRow-1][targetCol-1] = true;
        sendCellStatusUpdate(targetRow, targetCol, true);
        
        // 6. تحديث حالة loading zone
        loadingZoneOccupied = false;
        sendLoadingZoneUpdate(false);
        
        sendToESP32("STATUS:LOAD_RETURN_COMPLETE");
    } else {
        // إذا لم توجد خلية فارغة
        lcdStatus("NO EMPTY CELL", "Product in loading");
        sendToESP32("STATUS:NO_EMPTY_CELL");
    }
    
    homeArm();
    return;
}

  // ===== LOADING ZONE COMMANDS =====
  if (cmd == "LOADING_OPEN") { operateLoadingZone(true); return; }
  if (cmd == "LOADING_CLOSE") { operateLoadingZone(false); return; }

  if (cmd == "CHECK_LOADING") {
    bool occupied = checkLoadingZoneOccupied();
    lcdStatus("LOADING ZONE", occupied ? "OCCUPIED" : "EMPTY");
    return;
  }

  // ===== CONVEYOR MANUAL CONTROL =====
  if (cmd == "CONVEYOR_MOVE") {
    if (currentMode == MODE_MANUAL) {
      lcdStatus("MANUAL CONVEYOR", "Moving...");
      enableConveyorMotor(true);
      conveyorStepper.moveTo(999999);
    }
    return;
  }

  if (cmd == "CONVEYOR_STOP") {
    enableConveyorMotor(false);
    conveyorStepper.stop();
    lcdStatus("CONVEYOR", "Stopped");
    return;
  }

  if (cmd == "CONVEYOR_MOVE_12CM") {
    if (currentMode == MODE_MANUAL) {
      lcdStatus("CONVEYOR", "Moving 12cm...");
      enableConveyorMotor(true);
      conveyorStepper.move(STEPS_PER_12CM);
      convState = MOVE_12CM;
    }
    return;
  }

  // ===== MODE SWITCHING =====
  if (cmd == "MODE AUTO") {
    currentMode = MODE_AUTO;
    autoModeRunning = true;
    convState = IDLE;
    prevConvState = (RunState)(-1);
    enableConveyorMotor(false);
    conveyorStepper.stop();

    lcdStatus("MODE: AUTO", "RFID Conveyor");
    Serial.println("Switched to AUTO mode");
    sendToESP32("MODE:AUTO");

    if (autoTaskCount > 0) {
      lcdStatus("AUTO MODE", "Processing tasks...");
      sendToESP32("PROCESSING_TASKS");
    }
    return;
  }

  if (cmd == "MODE MANUAL") {
    currentMode = MODE_MANUAL;
    autoModeRunning = false;
    enableConveyorMotor(false);
    conveyorStepper.stop();
    convState = MANUAL_MODE;

    lcdStatus("MODE: MANUAL", "Ready");
    Serial.println("Switched to MANUAL mode");
    sendToESP32("MODE:MANUAL");
    return;
  }

  // ===== AUTO MODE CONTROL =====
  if (cmd == "AUTO START") {
    currentMode = MODE_AUTO;
    autoModeRunning = true;
    autoOneShot = false;
    convState = IDLE;
    lcdStatus("AUTO MODE", "Starting...");
    sendToESP32("AUTO_STARTED");
    return;
  }

  // ===== ONE-SHOT AUTO STOCK (from website button) =====
  // Runs: wait LDR1 → move 12cm → read RFID → move to LDR2 → pick & place by strategy
  if (cmd == "AUTO_ONESHOT_START") {
    currentMode = MODE_AUTO;
    autoModeRunning = true;
    autoOneShot = true;

    // Reset conveyor state machine timers
    manualPickArmed = false;
    conveyorJob = JOB_NONE;
    waitRfidStartMs = 0;
    convState = IDLE;
    prevConvState = (RunState)(-1);

    lcdStatus("AUTO ONE-SHOT", "Waiting LDR1");
    sendToESP32("AUTO_ONESHOT_STARTED");
    return;
  }


  if (cmd == "AUTO STOP") {
    autoModeRunning = false;
    autoOneShot = false;
    convState = MANUAL_MODE;
    enableConveyorMotor(false);
    conveyorStepper.stop();
    lcdStatus("AUTO MODE", "Stopped");
    sendToESP32("AUTO_STOPPED");
    return;
  }

  // ===== AUTO STOCK COMMAND WITH STRATEGY =====
if (cmd.startsWith("AUTO_STOCK:")) {
    String rfidTag = cmd.substring(11);
    rfidTag.trim();

    Serial.print("AUTO_STOCK command for RFID: ");
    Serial.println(rfidTag);

    lcdStatus("AUTO STOCK", "RFID: " + rfidTag);
    sendToESP32("AUTO_STOCK_START:" + rfidTag);

    currentRFID = rfidTag;
    lastTag = rfidTag;

    int col = -1, row = -1;
    
    if (getCellFromStrategy(col, row, rfidTag)) {  // ← هنا التغيير
      targetCol = col;
      targetRow = row;

      int idx = findTagIndex(rfidTag);
      if (idx >= 0) lastSymbol = TAG_SYMBOLS[idx];
      else lastSymbol = '?';

      Serial.print("Target (Strategy): C");
      Serial.print(targetCol);
      Serial.print(" R");
      Serial.println(targetRow);
      
      Serial.print("Strategy: ");
      switch(currentStorageStrategy) {
        case STRATEGY_NEAREST_EMPTY: Serial.println("NEAREST_EMPTY"); break;
        case STRATEGY_AI_OPTIMIZED: Serial.println("AI_OPTIMIZED"); break;
        case STRATEGY_FIXED: Serial.println("FIXED"); break;
      }

      lcdStatus("TAG:" + String(lastSymbol),
                "C" + String(targetCol) + " R" + String(targetRow));

      sendRFIDUpdate(rfidTag, String(lastSymbol));
            String cellMsg = "TARGET_CELL:";
      cellMsg += String(targetCol);
      cellMsg += ":";
      cellMsg += String(targetRow);
      sendToESP32(cellMsg);

      lcdStatus("AUTO STOCK", "Executing...");

      moveServosToPickupFromConveyor();

      if (targetCol > 0 && targetRow > 0) {
        goToColumn(targetCol);
        placeInRow_thenRetract(targetRow);
        
        rfidCellMap[targetRow-1][targetCol-1] = rfidTag;
        Serial.print("RFID ");
        Serial.print(rfidTag);
        Serial.print(" stored in R");
        Serial.print(targetRow);
        Serial.print(" C");
        Serial.println(targetCol);
      }

      homeArm();
      returnToDefaultPosition();

      sendToESP32("AUTO_STOCK_COMPLETE:" + rfidTag);
    } else {
      lcdStatus("NO EMPTY CELL", "Check Warehouse");
      sendToESP32("AUTO_STOCK_ERROR:NO_EMPTY_CELL");
    }
    return;
  }

  // ===== BASIC COMMANDS =====
  if (cmd == "HOME") {
    Serial.println("CMD: HOME");
    lcdStatus("CMD: HOME", "");
    homeArm();
    returnToDefaultPosition();
    return;
  }

  if (cmd == "PICK") {
    Serial.println("CMD: PICK (conveyor)");
    if (currentMode == MODE_MANUAL) {
      lcdStatus("MANUAL PICK", "Wait LDR1...");
      sendStatusUpdate("MANUAL_PICK_START");

      // Arm the manual pick sequence
      conveyorJob = JOB_MANUAL_PICK;
      manualPickArmed = true;
      manualPickStartMs = millis();
      waitRfidStartMs = 0;

      // Reset conveyor-related vars
      targetCol = -1;
      targetRow = -1;
      lastSymbol = '?';
      lastTag = "";
      currentRFID = "";

      enableConveyorMotor(false);
      conveyorStepper.stop();
      conveyorStepper.setCurrentPosition(0);
      convState = IDLE;          // start state machine but gated by manualPickArmed
      prevConvState = (RunState)(-1);
      return;
    }

    // AUTO mode (fallback): behaves as before (pick immediately)
    lcdStatus("CMD: PICK", "From Conveyor");
    moveServosToPickupFromConveyor();
    homeArm();
    returnToDefaultPosition();
    return;
  }

  if (cmd.startsWith("GOTO ")) {
    int spaceIndex = cmd.indexOf(' ');
    if (spaceIndex < 0) return;
    int col = cmd.substring(spaceIndex + 1).toInt();
    Serial.print("CMD: GOTO ");
    Serial.println(col);
    goToColumn(col);
    homeArm();
    returnToDefaultPosition();
    return;
  }

  if (cmd.startsWith("PLACE ")) {
    int space1 = cmd.indexOf(' ');
    int space2 = cmd.indexOf(' ', space1 + 1);
    if (space1 < 0 || space2 < 0) return;

    int col = cmd.substring(space1 + 1, space2).toInt();
    int row = cmd.substring(space2 + 1).toInt();

    Serial.print("CMD: PLACE ");
    Serial.print(col);
    Serial.print(" ");
    Serial.println(row);

    targetCol = col;
    targetRow = row;

    goToColumn(col);
    placeInRow_thenRetract(row);
    homeArm();
    return;
  }

  if (cmd.startsWith("TAKE ")) {
    int space1 = cmd.indexOf(' ');
    int space2 = cmd.indexOf(' ', space1 + 1);
    if (space1 < 0 || space2 < 0) return;

    int col = cmd.substring(space1 + 1, space2).toInt();
    int row = cmd.substring(space2 + 1).toInt();

    Serial.print("CMD: TAKE ");
    Serial.print(col);
    Serial.print(" ");
    Serial.println(row);

    targetCol = col;
    targetRow = row;

    lcdStatus("TAKE CELL", "C" + String(col) + " R" + String(row));
    sendStatusUpdate("PICK_FROM_CELL_START");

    goToColumn(col);
    pickFromRow_thenRetract(row);
    homeArm();

    sendStatusUpdate("PICK_FROM_CELL_DONE");
    return;
  }

  if (cmd == "GET_IR_STATUS") {
    sendAllCellStatus();
    return;
  }

  if (cmd == "GET_LOADING_STATUS") {
    bool occupied = checkLoadingZoneOccupied();
    lcdStatus("LOADING ZONE", occupied ? "OCCUPIED" : "EMPTY");
    sendLoadingZoneUpdate(occupied);
    return;
  }

  if (cmd == "GET_STATUS") {
    sendSensorUpdate();
    sendAllCellStatus();
    checkLoadingZoneOccupied();
    return;
  }

  if (cmd.startsWith("ADD_TASK:")) {
    String taskCmd = cmd.substring(9);
    addAutoTask(taskCmd);
    lcdStatus("TASK ADDED", taskCmd);
    sendToESP32("TASK_ADDED:" + taskCmd);
    return;
  }

  Serial.println("Unknown command.");
  lcdStatus("CMD: UNKNOWN", "");
}

// ============================
//       LCD STATE UPDATE
// ============================
void updateLCDForState() {
  if (convState == prevConvState) return;
  prevConvState = convState;

  switch (convState) {
    case IDLE:
      if (currentMode == MODE_MANUAL && manualPickArmed) {
        lcdStatus("MANUAL PICK", "Wait LDR1");
      } else {
        lcdStatus("AUTO: IDLE", "Waiting LDR1");
      }
      sendToESP32("STATE:IDLE");
      break;
    case MOVE_12CM:
      if (currentMode == MODE_MANUAL && manualPickArmed) {
        lcdStatus("MANUAL PICK", "Move 12cm");
      } else {
        lcdStatus("AUTO: MOVE", "Moving 12cm");
      }
      sendToESP32("STATE:MOVE_12CM");
      break;
    case WAIT_RFID:
      if (currentMode == MODE_MANUAL && manualPickArmed) {
        lcdStatus("MANUAL PICK", "Reading RFID");
      } else {
        lcdStatus("AUTO: WAIT", "Reading RFID");
      }
      sendToESP32("STATE:WAIT_RFID");
      break;
    case MOVING_TO_LDR2:
      if (currentMode == MODE_MANUAL && manualPickArmed) {
        lcdStatus("MANUAL PICK", "To LDR2");
      } else {
        lcdStatus("AUTO: MOVE", "To LDR2");
      }
      sendToESP32("STATE:MOVING_TO_LDR2");
      break;
    case STOPPED:
      if (currentMode == MODE_MANUAL) {
        lcdStatus("CONVEYOR STOP", "Clear LDR2");
      } else {
        lcdStatus("AUTO: STOP", "Clear LDR2");
      }
      sendToESP32("STATE:STOPPED");
      break;
    case MANUAL_MODE:
      lcdStatus("MANUAL MODE", "Ready");
      sendToESP32("STATE:MANUAL_MODE");
      break;
  }
}

// ============================
//       CONVEYOR STATE MACHINE
// ============================
void processConveyorStateMachine() {
  conveyorStepper.run();

  switch (convState) {
    case IDLE:
      // ✅ In AUTO: always active
      // ✅ In MANUAL: only active when manualPickArmed == true
      if (currentMode == MODE_MANUAL && !manualPickArmed) {
        break;
      }

      // Manual timeout waiting for LDR1
      if (currentMode == MODE_MANUAL && manualPickArmed) {
        if (millis() - manualPickStartMs > MANUAL_WAIT_LDR1_TIMEOUT_MS) {
          Serial.println(F("⏱️ MANUAL PICK timeout waiting LDR1"));
          sendStatusUpdate("MANUAL_PICK_ERROR:LDR1_TIMEOUT");
          manualPickArmed = false;
          conveyorJob = JOB_NONE;
          enableConveyorMotor(false);
          conveyorStepper.stop();
          convState = MANUAL_MODE;
          break;
        }
      }

      if (readLDRStable(LDR1_PIN, ldr1Baseline)) {
        Serial.println(F("📦 Object detected at LDR1 — moving 12cm..."));
        enableConveyorMotor(true);
        conveyorStepper.moveTo(conveyorStepper.currentPosition() + STEPS_PER_12CM);
        convState = MOVE_12CM;
      }
      break;

    case MOVE_12CM:
      if (conveyorStepper.distanceToGo() == 0) {
        Serial.println(F("📏 12cm reached — trying to read RFID..."));
        if (waitRfidStartMs == 0) waitRfidStartMs = millis();
        convState = WAIT_RFID;
      }
      break;

    case WAIT_RFID: {
      String tag;
      // Manual timeout for RFID
      if (currentMode == MODE_MANUAL && manualPickArmed) {
        if (waitRfidStartMs != 0 && (millis() - waitRfidStartMs > MANUAL_WAIT_RFID_TIMEOUT_MS)) {
          Serial.println(F("⏱️ MANUAL PICK timeout waiting RFID"));
          sendStatusUpdate("MANUAL_PICK_ERROR:RFID_TIMEOUT");
          manualPickArmed = false;
          conveyorJob = JOB_NONE;
          enableConveyorMotor(false);
          conveyorStepper.stop();
          convState = MANUAL_MODE;
          break;
        }
      }

      if (tryReadRFID(tag)) {
        Serial.print(F(" RFID Tag read: "));
        Serial.println(tag);
        currentRFID = tag;
        lastTag = tag;
        
        int idx = findTagIndex(tag);
        lastSymbol = (idx >= 0) ? TAG_SYMBOLS[idx] : '?';

        // ✅ الأهم: لازم نمرر RFID للـ strategy خصوصاً FIXED
        if (getCellFromStrategy(targetCol, targetRow, tag)) {
          Serial.print("Strategy selected: C"); Serial.print(targetCol);
          Serial.print(" R"); Serial.println(targetRow);
          lcdStatus("TAG:" + String(lastSymbol),
                    "C" + String(targetCol) + " R" + String(targetRow));
          sendRFIDUpdate(tag, String(lastSymbol));

          // Let the server/UI know which cell we are reserving for this RFID
          String cellMsg = "TARGET_CELL:";
          cellMsg += String(targetCol);
          cellMsg += ":";
          cellMsg += String(targetRow);
          sendToESP32(cellMsg);

          // More explicit operation start (ESP32 forwards to server)
          sendToESP32("AUTO_STOCK_START:" + tag);
        } else {
          // FIXED قد يفشل إذا الخلية محجوزة أو RFID مش بالماب
          Serial.println(F("❌ Strategy could not select a cell (ABORT)"));
          sendStatusUpdate("MANUAL_PICK_ERROR:STRATEGY_NO_CELL");
          // ✅ أوقف العملية بالكامل (خصوصاً في FIXED)
          manualPickArmed = false;
          conveyorJob = JOB_NONE;
          enableConveyorMotor(false);
          conveyorStepper.stop();
          convState = MANUAL_MODE;
          break;
        }

        conveyorStepper.moveTo(999999);
        Serial.println(F(" Conveyor moving until LDR2 triggered..."));
        convState = MOVING_TO_LDR2;
      }
      break;
    }

    case MOVING_TO_LDR2:
      if (readLDRStable(LDR2_PIN, ldr2Baseline)) {
        Serial.println(F("LDR2 detected object — stopping conveyor."));
        conveyorStepper.stop();
        enableConveyorMotor(false);
        convState = STOPPED;

        // ✅ Decide what to do after reaching LDR2 based on job
        if (currentMode == MODE_MANUAL && manualPickArmed && conveyorJob == JOB_MANUAL_PICK) {
          lcdStatus("MANUAL PICK", "Arm picking...");
          sendStatusUpdate("MANUAL_PICK_ARM_START");

          moveServosToPickupFromConveyor();
          homeArm();
          returnToDefaultPosition();

          sendStatusUpdate("MANUAL_PICK_DONE");
          manualPickArmed = false;
          conveyorJob = JOB_NONE;
        } else {
          // AUTO behavior: pick + place حسب الاستراتيجية
          if (targetCol > 0 && targetRow > 0) {
            lcdStatus("PICK & PLACE", "Processing...");
            moveServosToPickupFromConveyor();
            goToColumn(targetCol);
            placeInRow_thenRetract(targetRow);
            homeArm();
            returnToDefaultPosition();

            // Save RFID in local map so reorg / status can use it
            if (targetRow >= 1 && targetRow <= 3 && targetCol >= 1 && targetCol <= 4) {
              rfidCellMap[targetRow-1][targetCol-1] = currentRFID;
            }

            // Notify ESP32/server that the auto stock cycle completed
            if (currentRFID.length() > 0) {
              sendToESP32("AUTO_STOCK_COMPLETE:" + currentRFID);
            } else {
              sendToESP32("AUTO_STOCK_COMPLETE:");
            }

            // If this was a one-shot request from the website, stop auto mode now
            if (autoOneShot) {
              autoOneShot = false;
              autoModeRunning = false;
              currentMode = MODE_MANUAL;
              convState = MANUAL_MODE;
              sendToESP32("AUTO_ONESHOT_DONE");
            }
          }
        }
      }
      break;

    case STOPPED:
      if (!readLDRStable(LDR2_PIN, ldr2Baseline)) {
        Serial.println(F(" Object cleared — back to idle."));
        conveyorStepper.setCurrentPosition(0);
        targetCol = -1;
        targetRow = -1;
        lastSymbol = '?';
        lastTag = "";
        currentRFID = "";

        // In manual, return to MANUAL_MODE after finishing/canceling
        if (currentMode == MODE_MANUAL) {
          convState = MANUAL_MODE;
        } else {
          convState = IDLE;
        }
      }
      break;
      
    case MANUAL_MODE:
      // Nothing to do in manual mode
      break;
  }
}

// ============================
//       SETUP FUNCTION
// ============================
void setup() {
  Serial.begin(115200);
  ESP_SERIAL.begin(ESP_BAUD);

  lcd.init();
  lcd.backlight();
  lcdStatus("SYSTEM START", "Initializing...");

  Serial.println("=== SMART WAREHOUSE SYSTEM ===");
  Serial.println("COMPLETE VERSION WITH IR & ULTRASONIC & CONVEYOR");
  Serial.println("==============================");

  // Arm setup
  pinMode(ARM_DIR_PIN, OUTPUT);
  pinMode(ARM_STEP_PIN, OUTPUT);
  pinMode(ARM_ENABLE_PIN, OUTPUT);
  pinMode(LIMIT_SWITCH_PIN, INPUT_PULLUP);
  digitalWrite(ARM_ENABLE_PIN, LOW);

  // Servos setup
  s1.attach(S1_PIN);
  s2.attach(S2_PIN);
  s3.attach(S3_PIN);
  s4.attach(S4_PIN);
  s5.attach(S5_PIN);
  s6.attach(S6_PIN);
  loadingServo.attach(LOADING_SERVO_PIN);
pinMode(ULTRA_TRIG, OUTPUT);
pinMode(ULTRA_ECHO, INPUT);

  s1.write(s1Default); delay(100);
  s2.write(s2Default); delay(100);
  s3.write(s3Default); delay(100);
  s4.write(s4Default); delay(100);
  s5.write(s5Default); delay(100);
  s6.write(s6Default); delay(100);
  loadingServo.write(loadingServoDefault); delay(100);

  // IR Sensors setup
  setupIRSensors();
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 4; col++) {
      cellOccupied[row][col] = readIRStable(IR_PINS[row][col], irBaseline[row][col]);
      irSameCount[row][col] = 0;
      lastCellStatus[row][col] = cellOccupied[row][col];
    }
  }

  // Conveyor setup
  setupConveyorStepper();

  // RFID setup
  Serial1.begin(115200);
  nfc.begin();
  uint32_t versiondata = nfc.getFirmwareVersion();
  if (!versiondata) {
    Serial.println("ERROR: PN532 not found!");
    lcdStatus("ERROR", "PN532 not found");
    while (1);
  }
  nfc.SAMConfig();
  Serial.println("PN532 ready.");

  // Home arm and return to default
  homeArm();
  returnToDefaultPosition();

  // Initialize auto tasks
  autoTaskCount = 0;
  currentTaskIndex = -1;

  randomSeed(analogRead(0));

  lcdStatus("READY", "Mode: MANUAL");
  sendToESP32("ARDUINO:READY");

  sendAllCellStatus();
  checkLoadingZoneOccupied();

  Serial.println("System Ready! (Complete Version with IR, Ultrasonic & Conveyor)");
}

// ============================
//       LOOP FUNCTION
// ============================
void loop() {
  static unsigned long lastSensorUpdate = 0;
  static unsigned long lastIRCheck = 0;
  static unsigned long lastUltrasonicCheck = 0;
  static unsigned long lastAllCellPush = 0;

  // 🚀 Priority: keep conveyor stepper running as fast as possible
  conveyorStepper.run();

  // Are we in a conveyor-critical window?
  bool conveyorBusy = manualPickArmed ||
                      (currentMode == MODE_AUTO && autoModeRunning &&
                       (convState != IDLE && convState != MANUAL_MODE));

  // ✅ While conveyor is busy, reduce background work (it slows AccelStepper.run)
  if (!conveyorBusy) {
    updateLoadingZoneScan();

    // Check IR sensors
    if (millis() - lastIRCheck > 100) {
      updateCellOccupancyFromSensors();
      lastIRCheck = millis();
    }

    if (millis() - lastUltrasonicCheck > 250) {
      checkLoadingZoneOccupied();
      lastUltrasonicCheck = millis();
    }

    if (millis() - lastIRGridUpdate > 1000) {
      sendIRGridUpdate();
      lastIRGridUpdate = millis();
    }

    // Send sensor updates
    if (millis() - lastSensorUpdate > 250) {
      sendSensorUpdate();
      lastSensorUpdate = millis();
    }

    // Safety push
    if (millis() - lastAllCellPush > 2000) {
      sendAllCellStatus();
      lastAllCellPush = millis();
    }
  } else {
    // Minimal: only keep the most important signal (optional)
    if (millis() - lastSensorUpdate > 600) {
      sendSensorUpdate();
      lastSensorUpdate = millis();
    }
  }

  // ---- Conveyor state machine ----
  if (currentMode == MODE_AUTO && autoModeRunning) {
    updateLCDForState();
    processConveyorStateMachine();

    // Process auto tasks if any
    if (autoTaskCount > 0 && convState == IDLE) {
      processNextAutoTask();
    }
  } else {
    // Manual mode
    if (manualPickArmed) {
      updateLCDForState();
      processConveyorStateMachine();
    } else {
      if (convState != MANUAL_MODE) {
        enableConveyorMotor(false);
        conveyorStepper.stop();
        convState = MANUAL_MODE;
        prevConvState = (RunState)(-1);
      }
    }
  }

  // Keep stepper running (again)
  conveyorStepper.run();

  // ---- Commands ----
  if (Serial.available()) {
    String cmd = readCommand(Serial);
    handleCommand(cmd);
  }

  if (ESP_SERIAL.available()) {
    String cmd = readCommand(ESP_SERIAL);
    handleCommand(cmd);
  }

  // Final run
  conveyorStepper.run();
}





