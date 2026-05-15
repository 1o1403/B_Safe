/*
  B-SAFE ESP32 통합 코드 - ERI / 원인 분석 추가 버전

  추가 기능:
  1) 전압 변화율 dV/dt 계산
  2) 전압 하강속도 voltage_drop_rate 계산
  3) 전류 대비 전압강하 기반 내부저항 추정값 계산
  4) 6개 위험 점수 계산
     - 온도위험점수
     - 온도상승율점수
     - 전압위험점수
     - 전압변화율점수
     - 전압강하/내부저항점수
     - 전류위험점수
  5) ERI 계산: 내부 ERI는 0~1000점, 표시용 ERI는 0.0~100.0으로 환산
  6) 상태 변화 원인 primary_cause / secondary_cause / cause_detail 생성
  7) OLED에는 상태, 표시용 ERI(0.0~100.0), 기본 센서값만 표시
  8) 웹서버 JSON에는 ERI, 각 점수, 원인 분석 정보까지 전송

  하드웨어:
  - NTC 10kΩ, Beta 3950 → GPIO 34
  - 배터리 전체 팩 전압 → 30kΩ + 10kΩ 전압분배 → GPIO 35
  - ACS712 5A → OUT 전압분배 후 GPIO 36
  - OLED SSD1306 I2C → SDA GPIO 21, SCL GPIO 22
  - 초록 LED → GPIO 25
  - 노랑 LED → GPIO 26
  - 빨강 LED → GPIO 27
  - 부저 → GPIO 14
*/

#include <WiFi.h>
#include <HTTPCli ent.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <math.h>

// =====================================================
// 1. WiFi / Flask 서버 설정
// =====================================================

const char* WIFI_SSID = "KSH S24";
const char* WIFI_PASSWORD = "38902825";

// 노트북 Flask 서버 주소
// 예: http://192.168.0.15:5000/api/data
const char* SERVER_URL = "http://10.78.80.11:5000/api/data";

// =====================================================
// 2. 핀 설정
// =====================================================

#define TEMP_PIN      34
#define PACK_V_PIN    35
#define CURRENT_PIN   36

#define OLED_SDA      21
#define OLED_SCL      22

#define LED_GREEN     25
#define LED_YELLOW    26
#define LED_RED       27
#define BUZZER_PIN    14

// =====================================================
// 3. OLED 설정
// =====================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledOK = false;

// =====================================================
// 4. ADC / 센서 상수
// =====================================================

const float ADC_MAX = 4095.0;
const float ADC_REF = 3.3;

// NTC 설정
const float NTC_R0 = 10000.0;
const float NTC_BETA = 3950.0;
const float NTC_T0 = 298.15;
const float FIXED_R = 10000.0;

// 배터리 팩 전압분배
// 배터리 + → 30kΩ → 측정점 → 10kΩ → GND
const float PACK_R1 = 30000.0;
const float PACK_R2 = 10000.0;
const float PACK_DIVIDER_FACTOR = (PACK_R1 + PACK_R2) / PACK_R2;  // 4.0

// ACS712 5A 설정
// ACS712 5A 감도 = 185mV/A
const float ACS_SENSITIVITY = 0.185;

// ACS712 OUT 전압분배 복원 계수
// OUT → 10kΩ → 측정점 → 20kΩ → GND
// GPIO 전압 = ACS_OUT * 20 / (10 + 20) = ACS_OUT * 0.667
// ACS_OUT = GPIO 전압 * 1.5
const float ACS_OUT_RESTORE_FACTOR = 1.5;

// ACS712 무전류 기준 전압
float acsZeroVoltage = 2.5;

// =====================================================
// 5. 위험 기준값
// =====================================================

// 시연용이면 true: 온도 기준을 낮게 잡아서 손으로 데워도 반응함
// 실제 기준으로 발표/테스트하려면 false로 바꿀 것
const bool DEMO_MODE = false;

const float TEMP_WARN = DEMO_MODE ? 25.0 : 45.0;
const float TEMP_DANGER = DEMO_MODE ? 29.0 : 60.0;
const float TEMP_SCORE_SAFE = DEMO_MODE ? 20.0 : 30.0;

const float TEMP_RATE_WARN = 1.0;       // ℃/s
const float TEMP_RATE_DANGER = 2.0;     // ℃/s

const float PACK_LOW_WARN = 9.9;        // 3S 기준, 셀 평균 3.3V
const float PACK_LOW_DANGER = 9.0;      // 3S 기준, 셀 평균 3.0V
const float PACK_OVER_DANGER = 12.6;    // 3S 기준, 셀 평균 4.2V

const float CURRENT_WARN = 2.0;         // A, 시연용 주의 기준
const float CURRENT_DANGER = 4.0;       // A, ACS712 5A 기준 임시 위험값

// 전압 변화율 기준
// voltage_rate = dV/dt [V/s]
// voltage_drop_rate = max(0, -voltage_rate)
const float VOLT_DROP_RATE_WARN = 0.03;     // V/s
const float VOLT_DROP_RATE_DANGER = 0.10;   // V/s

// 전류 대비 전압강하 기반 내부저항 추정 기준
// R_est = voltage_sag / max(abs(I), MIN_CURRENT_FOR_R)
const float MIN_CURRENT_FOR_R = 0.3;         // A, 0으로 나누기 방지
const float R_EST_WARN = 0.05;               // ohm
const float R_EST_DANGER = 0.10;             // ohm
const float R_EST_SCORE_SAFE = 0.02;         // ohm

// ERI 기준
// 각 항목 점수는 원인 분석을 위해 0~100점으로 유지
// ERI 내부값은 6개 점수 합산값을 0~1000점으로 정규화
// 표시값은 ERI / 10 = 0.0~100.0
const float ERI_MAX_SCORE = 1000.0;
const float ERI_DISPLAY_DIVIDER = 10.0;
const float ERI_WARN = 250.0;      // 표시값 25.0/100.0
const float ERI_DANGER = 500.0;    // 표시값 50.0/100.0

// 원인 목록에 넣을 최소 점수
const float CAUSE_LIST_MIN_SCORE = 60.0;

// =====================================================
// 6. 시간 / 상태 변수
// =====================================================

unsigned long lastMeasureTime = 0;
unsigned long lastSendTime = 0;

const unsigned long MEASURE_INTERVAL_MS = 1000;
const unsigned long SEND_INTERVAL_MS = 1000;

float prevTemp = NAN;
float prevPackVoltage = NAN;

float currentTemp = NAN;
float currentTempRate = 0.0;
float currentPackVoltage = 0.0;
float currentCellAvg = 0.0;
float currentCurrent = 0.0;

float currentVoltageRate = 0.0;        // dV/dt [V/s]
float currentVoltageDropRate = 0.0;    // max(0, -dV/dt) [V/s]
float currentVoltageSag = 0.0;         // max(0, Vprev - Vnow) [V]
float currentInternalResistance = 0.0; // voltage sag / current [ohm], 간이 추정값

float tempScore = 0.0;
float tempRateScore = 0.0;
float voltageScore = 0.0;
float voltageRateScore = 0.0;
float resistanceScore = 0.0;
float currentScore = 0.0;
float eriRawSum = 0.0;          // 6개 원점수 합산값, 최대 600
float eri = 0.0;                // 0~1000점 정규화 ERI
float eriPercent = 0.0;         // 표시용 ERI, 0.0~100.0

String currentStatus = "READY";
String currentMessage = "System ready";
String statusTrigger = "System ready";
String primaryCause = "데이터 대기";
float primaryScore = 0.0;
String secondaryCause = "-";
float secondaryScore = 0.0;
String causeDetail = "ESP32 데이터 대기 중";
String causeListJson = "[]";

// =====================================================
// 7. 보조 함수
// =====================================================

float clampFloat(float value, float minValue, float maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

// inMin < inMax, inMin > inMax 둘 다 처리 가능
float mapClampFloat(float value, float inMin, float inMax, float outMin, float outMax) {
  if (inMin == inMax) {
    return outMin;
  }

  float ratio = (value - inMin) / (inMax - inMin);
  ratio = clampFloat(ratio, 0.0, 1.0);

  return outMin + ratio * (outMax - outMin);
}

String jsonEscape(String text) {
  text.replace("\\", "\\\\");
  text.replace("\"", "\\\"");
  text.replace("\n", " ");
  text.replace("\r", " ");
  return text;
}

// =====================================================
// 8. ADC 평균 읽기 함수
// =====================================================

int readAdcAverage(int pin, int samples = 20) {
  long sum = 0;

  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }

  return sum / samples;
}

// =====================================================
// 9. ADC raw → 전압 변환
// =====================================================

float rawToVoltage(int raw) {
  return ((float)raw * ADC_REF) / ADC_MAX;
}

// =====================================================
// 10. NTC 온도 계산
// 회로: 3.3V → NTC → 측정점(GPIO34) → 10kΩ → GND
// =====================================================

float readTemperatureC() {
  int raw = readAdcAverage(TEMP_PIN);

  if (raw <= 0) {
    return NAN;
  }

  float rNTC = FIXED_R * (ADC_MAX / (float)raw - 1.0);

  if (rNTC <= 0) {
    return NAN;
  }

  float tempK = 1.0 / ((log(rNTC / NTC_R0) / NTC_BETA) + (1.0 / NTC_T0));
  float tempC = tempK - 273.15;

  return tempC;
}

// =====================================================
// 11. 배터리 팩 전압 계산
// 회로: 배터리 + → 30kΩ → 측정점(GPIO35) → 10kΩ → GND
// =====================================================

float readPackVoltage() {
  int raw = readAdcAverage(PACK_V_PIN);
  float adcVoltage = rawToVoltage(raw);
  float packVoltage = adcVoltage * PACK_DIVIDER_FACTOR;

  return packVoltage;
}

// =====================================================
// 12. ACS712 5A 전류 계산
// =====================================================

float readCurrentA() {
  int raw = readAdcAverage(CURRENT_PIN);

  float gpioVoltage = rawToVoltage(raw);
  float acsOutVoltage = gpioVoltage * ACS_OUT_RESTORE_FACTOR;

  float current = (acsOutVoltage - acsZeroVoltage) / ACS_SENSITIVITY;

  return current;
}

// =====================================================
// 13. ACS712 영점 보정
// setup() 때 부하가 없을 때 실행하는 것이 가장 좋음
// =====================================================

void calibrateACS712() {
  const int samples = 100;
  float sum = 0.0;

  for (int i = 0; i < samples; i++) {
    int raw = analogRead(CURRENT_PIN);
    float gpioVoltage = rawToVoltage(raw);
    float acsOutVoltage = gpioVoltage * ACS_OUT_RESTORE_FACTOR;
    sum += acsOutVoltage;
    delay(10);
  }

  acsZeroVoltage = sum / samples;

  Serial.print("ACS712 zero voltage calibrated: ");
  Serial.print(acsZeroVoltage, 3);
  Serial.println(" V");
}

// =====================================================
// 14. 변화율 계산
// =====================================================

void updateDerivedValues(float dt) {
  // 온도 상승 속도 dT/dt
  if (!isnan(currentTemp) && !isnan(prevTemp) && dt > 0.0) {
    currentTempRate = (currentTemp - prevTemp) / dt;
  } else {
    currentTempRate = 0.0;
  }

  // 전압 변화율 dV/dt
  if (!isnan(prevPackVoltage) && dt > 0.0) {
    currentVoltageRate = (currentPackVoltage - prevPackVoltage) / dt;
  } else {
    currentVoltageRate = 0.0;
  }

  // 전압 하강속도: 하강하는 경우만 양수 처리
  currentVoltageDropRate = fmax(0.0, -currentVoltageRate);

  // 순간 전압강하량
  if (!isnan(prevPackVoltage)) {
    currentVoltageSag = fmax(0.0, prevPackVoltage - currentPackVoltage);
  } else {
    currentVoltageSag = 0.0;
  }

  // 전류 대비 전압강하 기반 내부저항 추정값
  // 실제 내부저항 정밀 측정이 아니라, 발표에서는 "전압강하 기반 내부저항 추정 지표"라고 표현해야 함
  float absCurrent = fabs(currentCurrent);

  if (absCurrent >= MIN_CURRENT_FOR_R) {
    currentInternalResistance = currentVoltageSag / absCurrent;
  } else {
    currentInternalResistance = 0.0;
  }
}

// =====================================================
// 15. 위험 점수 계산
// =====================================================

void updateRiskScores() {
  float absCurrent = fabs(currentCurrent);

  // 1) 온도위험점수
  if (!isnan(currentTemp)) {
    tempScore = mapClampFloat(currentTemp, TEMP_SCORE_SAFE, TEMP_DANGER, 0.0, 100.0);
  } else {
    tempScore = 0.0;
  }

  // 2) 온도상승율점수
  tempRateScore = mapClampFloat(currentTempRate, 0.0, TEMP_RATE_DANGER, 0.0, 100.0);

  // 3) 전압위험점수
  if (currentPackVoltage <= PACK_LOW_DANGER) {
    voltageScore = 100.0;
  } else if (currentPackVoltage <= PACK_LOW_WARN) {
    voltageScore = mapClampFloat(currentPackVoltage, PACK_LOW_WARN, PACK_LOW_DANGER, 60.0, 100.0);
  } else if (currentPackVoltage > PACK_OVER_DANGER) {
    voltageScore = 100.0;
  } else {
    voltageScore = mapClampFloat(currentPackVoltage, PACK_OVER_DANGER, PACK_LOW_WARN, 0.0, 60.0);
  }

  // 4) 전압변화율점수
  voltageRateScore = mapClampFloat(currentVoltageDropRate, 0.0, VOLT_DROP_RATE_DANGER, 0.0, 100.0);

  // 5) 전압강하/내부저항점수
  resistanceScore = mapClampFloat(currentInternalResistance, R_EST_SCORE_SAFE, R_EST_DANGER, 0.0, 100.0);

  // 6) 전류위험점수
  currentScore = mapClampFloat(absCurrent, 0.0, CURRENT_DANGER, 0.0, 100.0);

  // ERI 계산
  // 원점수 합산 최대값 = 6개 항목 x 100점 = 600점
  // 사용자가 보기 쉽게 0~1000점으로 정규화
  // 화면 표시값은 0.0~100.0으로 사용
  eriRawSum = tempScore + tempRateScore + voltageScore + voltageRateScore + resistanceScore + currentScore;
  eri = (eriRawSum / 600.0) * ERI_MAX_SCORE;
  eri = clampFloat(eri, 0.0, ERI_MAX_SCORE);
  eriPercent = eri / ERI_DISPLAY_DIVIDER;
}

// =====================================================
// 16. 원인 분석
// =====================================================

String causeNameByIndex(int index) {
  if (index == 0) return "온도 위험";
  if (index == 1) return "온도 상승속도";
  if (index == 2) return "전압 위험";
  if (index == 3) return "전압 급락";
  if (index == 4) return "전류 대비 전압강하";
  if (index == 5) return "전류 위험";
  return "알 수 없음";
}

String causeKeyByIndex(int index) {
  if (index == 0) return "temp";
  if (index == 1) return "temp_rate";
  if (index == 2) return "voltage";
  if (index == 3) return "voltage_rate";
  if (index == 4) return "resistance";
  if (index == 5) return "current";
  return "unknown";
}

String causeDescriptionByIndex(int index) {
  if (index == 0) return "배터리 온도 상승";
  if (index == 1) return "온도가 빠르게 상승 중";
  if (index == 2) return "팩 전압이 정상 범위에서 벗어남";
  if (index == 3) return "전압이 짧은 시간에 빠르게 감소";
  if (index == 4) return "전류 대비 전압강하가 증가";
  if (index == 5) return "부하 전류가 증가";
  return "원인 불명";
}

void updateCauseAnalysis() {
  float scores[6] = {
    tempScore,
    tempRateScore,
    voltageScore,
    voltageRateScore,
    resistanceScore,
    currentScore
  };

  int firstIndex = 0;
  int secondIndex = 1;

  if (scores[secondIndex] > scores[firstIndex]) {
    int tempIndex = firstIndex;
    firstIndex = secondIndex;
    secondIndex = tempIndex;
  }

  for (int i = 2; i < 6; i++) {
    if (scores[i] > scores[firstIndex]) {
      secondIndex = firstIndex;
      firstIndex = i;
    } else if (scores[i] > scores[secondIndex]) {
      secondIndex = i;
    }
  }

  primaryCause = causeNameByIndex(firstIndex);
  primaryScore = scores[firstIndex];
  secondaryCause = causeNameByIndex(secondIndex);
  secondaryScore = scores[secondIndex];

  // 60점 이상인 원인들을 JSON 배열로 생성
  causeListJson = "[";
  bool firstItem = true;

  for (int i = 0; i < 6; i++) {
    if (scores[i] >= CAUSE_LIST_MIN_SCORE) {
      if (!firstItem) {
        causeListJson += ",";
      }

      causeListJson += "{";
      causeListJson += "\"key\":\"" + causeKeyByIndex(i) + "\",";
      causeListJson += "\"name\":\"" + jsonEscape(causeNameByIndex(i)) + "\",";
      causeListJson += "\"score\":" + String(scores[i], 1) + ",";
      causeListJson += "\"description\":\"" + jsonEscape(causeDescriptionByIndex(i)) + "\"";
      causeListJson += "}";

      firstItem = false;
    }
  }

  causeListJson += "]";

  if (currentStatus == "NORMAL") {
    causeDetail = "모든 위험 점수가 정상 범위입니다.";
  } else if (statusTrigger == "ERI 누적 위험") {
    causeDetail = primaryCause + " 점수 " + String(primaryScore, 1) + "점과 " + secondaryCause + " 점수 " + String(secondaryScore, 1) + "점이 ERI 상승에 크게 기여했습니다.";
  } else {
    causeDetail = statusTrigger + " 조건으로 상태가 변경되었습니다. 주요 기여 항목은 " + primaryCause + " " + String(primaryScore, 1) + "점입니다.";
  }
}

// =====================================================
// 17. 위험 상태 판단
// =====================================================

void updateStatus() {
  float absCurrent = fabs(currentCurrent);

  currentStatus = "NORMAL";
  currentMessage = "Normal";
  statusTrigger = "Normal";

  // 1) 개별 DANGER 조건 우선 판단
  if (!isnan(currentTemp) && currentTemp >= TEMP_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "High temperature";
    statusTrigger = "온도 위험";
  }
  else if (currentTempRate >= TEMP_RATE_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "Temperature rising fast";
    statusTrigger = "온도 상승속도 위험";
  }
  else if (currentPackVoltage <= PACK_LOW_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "Pack voltage too low";
    statusTrigger = "저전압 위험";
  }
  else if (currentPackVoltage > PACK_OVER_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "Pack over voltage";
    statusTrigger = "과전압 위험";
  }
  else if (absCurrent >= CURRENT_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "Over current";
    statusTrigger = "과전류 위험";
  }
  else if (currentVoltageDropRate >= VOLT_DROP_RATE_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "Voltage dropping fast";
    statusTrigger = "전압 급락 위험";
  }
  else if (currentInternalResistance >= R_EST_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "High voltage sag";
    statusTrigger = "전류 대비 전압강하 위험";
  }

  // 2) 개별 WARN 조건 판단
  else if (!isnan(currentTemp) && currentTemp >= TEMP_WARN) {
    currentStatus = "WARN";
    currentMessage = "Temperature warning";
    statusTrigger = "온도 주의";
  }
  else if (currentTempRate >= TEMP_RATE_WARN) {
    currentStatus = "WARN";
    currentMessage = "Temperature rising";
    statusTrigger = "온도 상승속도 주의";
  }
  else if (currentPackVoltage <= PACK_LOW_WARN) {
    currentStatus = "WARN";
    currentMessage = "Pack voltage low";
    statusTrigger = "저전압 주의";
  }
  else if (absCurrent >= CURRENT_WARN) {
    currentStatus = "WARN";
    currentMessage = "Current warning";
    statusTrigger = "전류 주의";
  }
  else if (currentVoltageDropRate >= VOLT_DROP_RATE_WARN) {
    currentStatus = "WARN";
    currentMessage = "Voltage drop warning";
    statusTrigger = "전압 하강속도 주의";
  }
  else if (currentInternalResistance >= R_EST_WARN) {
    currentStatus = "WARN";
    currentMessage = "Voltage sag warning";
    statusTrigger = "전류 대비 전압강하 주의";
  }

  // 3) ERI 누적 위험 판단
  // 개별 항목이 임계값을 넘지 않아도 복합 위험이면 상태를 올림
  if (currentStatus == "NORMAL") {
    if (eri >= ERI_DANGER) {
      currentStatus = "DANGER";
      currentMessage = "ERI danger";
      statusTrigger = "ERI 누적 위험";
    } else if (eri >= ERI_WARN) {
      currentStatus = "WARN";
      currentMessage = "ERI warning";
      statusTrigger = "ERI 누적 위험";
    }
  } else if (currentStatus == "WARN" && eri >= ERI_DANGER) {
    currentStatus = "DANGER";
    currentMessage = "ERI danger";
    statusTrigger = "ERI 누적 위험";
  }

  updateCauseAnalysis();
}

// =====================================================
// 18. LED + 부저 제어
// =====================================================

void buzzerOn() {
  ledcWriteTone(BUZZER_PIN, 2000);
}

void buzzerOff() {
  ledcWriteTone(BUZZER_PIN, 0);
}

void updateOutputs() {
  if (currentStatus == "NORMAL") {
    digitalWrite(LED_GREEN, HIGH);
    digitalWrite(LED_YELLOW, LOW);
    digitalWrite(LED_RED, LOW);
    buzzerOff();
  }
  else if (currentStatus == "WARN") {
    digitalWrite(LED_GREEN, LOW);
    digitalWrite(LED_YELLOW, HIGH);
    digitalWrite(LED_RED, LOW);
    buzzerOff();
  }
  else if (currentStatus == "DANGER") {
    digitalWrite(LED_GREEN, LOW);
    digitalWrite(LED_YELLOW, LOW);
    digitalWrite(LED_RED, HIGH);
    buzzerOn();
  }
  else {
    digitalWrite(LED_GREEN, LOW);
    digitalWrite(LED_YELLOW, LOW);
    digitalWrite(LED_RED, LOW);
    buzzerOff();
  }
}

// =====================================================
// 19. OLED 표시
// OLED에는 원인 분석 상세정보를 표시하지 않음
// =====================================================

void updateOLED() {
  if (!oledOK) {
    return;
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("B-SAFE");

  display.setCursor(0, 12);
  display.print("STATUS: ");
  display.println(currentStatus);

  display.setCursor(0, 24);
  display.print("ERI: ");
  display.print(eriPercent, 1);
  display.println("/100");

  display.setCursor(0, 36);
  display.print("T:");
  if (isnan(currentTemp)) {
    display.print("--.-C");
  } else {
    display.print(currentTemp, 1);
    display.print("C");
  }

  display.print(" V:");
  display.print(currentPackVoltage, 2);

  display.setCursor(0, 48);
  display.print("I:");
  display.print(currentCurrent, 2);
  display.print("A ");
  display.print("dV:");
  display.print(currentVoltageRate, 2);

  display.display();
}

// =====================================================
// 20. 시리얼 출력
// =====================================================

void printSerialData() {
  Serial.println("------------------------------");

  Serial.print("Temp: ");
  if (isnan(currentTemp)) {
    Serial.print("nan");
  } else {
    Serial.print(currentTemp, 2);
  }

  Serial.print(" C, TempRate: ");
  Serial.print(currentTempRate, 2);

  Serial.print(" C/s, Pack: ");
  Serial.print(currentPackVoltage, 2);

  Serial.print(" V, CellAvg: ");
  Serial.print(currentCellAvg, 2);

  Serial.print(" V, Current: ");
  Serial.print(currentCurrent, 2);

  Serial.print(" A, dV/dt: ");
  Serial.print(currentVoltageRate, 3);

  Serial.print(" V/s, DropRate: ");
  Serial.print(currentVoltageDropRate, 3);

  Serial.print(" V/s, R_est: ");
  Serial.print(currentInternalResistance, 4);

  Serial.println(" ohm");

  Serial.print("Scores => T:");
  Serial.print(tempScore, 1);
  Serial.print(" dT:");
  Serial.print(tempRateScore, 1);
  Serial.print(" V:");
  Serial.print(voltageScore, 1);
  Serial.print(" dV:");
  Serial.print(voltageRateScore, 1);
  Serial.print(" R:");
  Serial.print(resistanceScore, 1);
  Serial.print(" I:");
  Serial.print(currentScore, 1);

  Serial.print(" | ERI: ");
  Serial.print(eri, 1);
  Serial.print("/1000 (");
  Serial.print(eriPercent, 1);
  Serial.print("/100)");

  Serial.print(" | Status: ");
  Serial.print(currentStatus);

  Serial.print(" | Trigger: ");
  Serial.print(statusTrigger);

  Serial.print(" | Cause: ");
  Serial.print(primaryCause);
  Serial.print(" ");
  Serial.print(primaryScore, 1);
  Serial.println("점");
}

// =====================================================
// 21. Flask 서버로 JSON 전송
// =====================================================

void sendDataToServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected. Skip sending data.");
    return;
  }

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");

  float elapsedTime = millis() / 1000.0;

  String json = "{";
  json += "\"time\":" + String(elapsedTime, 1) + ",";

  json += "\"temp\":";
  if (isnan(currentTemp)) {
    json += "null,";
  } else {
    json += String(currentTemp, 2) + ",";
  }

  json += "\"temp_rate\":" + String(currentTempRate, 3) + ",";
  json += "\"pack_voltage\":" + String(currentPackVoltage, 3) + ",";
  json += "\"cell_avg\":" + String(currentCellAvg, 3) + ",";
  json += "\"current\":" + String(currentCurrent, 3) + ",";

  // 새로 추가된 분석값
  json += "\"voltage_rate\":" + String(currentVoltageRate, 4) + ",";
  json += "\"voltage_drop_rate\":" + String(currentVoltageDropRate, 4) + ",";
  json += "\"voltage_sag\":" + String(currentVoltageSag, 4) + ",";
  json += "\"internal_resistance\":" + String(currentInternalResistance, 5) + ",";

  // 6개 점수
  json += "\"temp_score\":" + String(tempScore, 1) + ",";
  json += "\"temp_rate_score\":" + String(tempRateScore, 1) + ",";
  json += "\"voltage_score\":" + String(voltageScore, 1) + ",";
  json += "\"voltage_rate_score\":" + String(voltageRateScore, 1) + ",";
  json += "\"resistance_score\":" + String(resistanceScore, 1) + ",";
  json += "\"current_score\":" + String(currentScore, 1) + ",";
  json += "\"eri_raw_sum\":" + String(eriRawSum, 1) + ",";
  json += "\"eri\":" + String(eri, 1) + ",";
  json += "\"eri_percent\":" + String(eriPercent, 1) + ",";

  // 원인 분석 정보
  json += "\"primary_cause\":\"" + jsonEscape(primaryCause) + "\",";
  json += "\"primary_score\":" + String(primaryScore, 1) + ",";
  json += "\"secondary_cause\":\"" + jsonEscape(secondaryCause) + "\",";
  json += "\"secondary_score\":" + String(secondaryScore, 1) + ",";
  json += "\"status_trigger\":\"" + jsonEscape(statusTrigger) + "\",";
  json += "\"cause_detail\":\"" + jsonEscape(causeDetail) + "\",";
  json += "\"cause_list\":" + causeListJson + ",";

  json += "\"status\":\"" + currentStatus + "\",";
  json += "\"message\":\"" + jsonEscape(currentMessage) + "\"";
  json += "}";

  int httpResponseCode = http.POST(json);

  Serial.print("POST result: ");
  Serial.println(httpResponseCode);

  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.print("Server response: ");
    Serial.println(response);
  } else {
    Serial.print("POST failed. Error: ");
    Serial.println(http.errorToString(httpResponseCode));
  }

  http.end();
}

// =====================================================
// 22. WiFi 연결
// =====================================================

void connectWiFi() {
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retry = 0;

  while (WiFi.status() != WL_CONNECTED && retry < 30) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected.");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi connection failed.");
  }
}

// =====================================================
// 23. setup()
// =====================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=================================");
  Serial.println("B-SAFE ESP32 START - ERI VERSION");
  Serial.println("=================================");

  // GPIO 출력 설정
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  ledcAttach(BUZZER_PIN, 2000, 8);

  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(LED_RED, LOW);
  ledcWriteTone(BUZZER_PIN, 0);

  // ADC 설정
  analogReadResolution(12);
  analogSetPinAttenuation(TEMP_PIN, ADC_11db);
  analogSetPinAttenuation(PACK_V_PIN, ADC_11db);
  analogSetPinAttenuation(CURRENT_PIN, ADC_11db);

  // I2C / OLED 초기화
  Wire.begin(OLED_SDA, OLED_SCL);

  oledOK = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);

  if (!oledOK) {
    Serial.println("OLED 0x3C failed. Trying 0x3D...");
    oledOK = display.begin(SSD1306_SWITCHCAPVCC, 0x3D);
  }

  if (oledOK) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("B-SAFE");
    display.println("ERI VERSION");
    display.println("Calibrating...");
    display.display();
  } else {
    Serial.println("OLED initialization failed.");
  }

  // ACS712 영점 보정
  // 가능하면 부하 없이 켜고 보정해야 전류 0A 기준이 맞음
  calibrateACS712();

  // WiFi 연결
  connectWiFi();

  if (oledOK) {
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("B-SAFE READY");

    if (WiFi.status() == WL_CONNECTED) {
      display.println("WiFi OK");
      display.print("IP:");
      display.println(WiFi.localIP());
    } else {
      display.println("WiFi FAIL");
    }

    display.display();
    delay(1500);
  }

  // 초기값 세팅
  currentTemp = readTemperatureC();
  currentPackVoltage = readPackVoltage();
  currentCellAvg = currentPackVoltage / 3.0;
  currentCurrent = readCurrentA();

  if (!isnan(currentTemp)) {
    prevTemp = currentTemp;
  }
  prevPackVoltage = currentPackVoltage;

  lastMeasureTime = millis();
  lastSendTime = millis();
}

// =====================================================
// 24. loop()
// =====================================================

void loop() {
  unsigned long now = millis();

  // 센서 측정 주기
  if (now - lastMeasureTime >= MEASURE_INTERVAL_MS) {
    float dt = (now - lastMeasureTime) / 1000.0;
    lastMeasureTime = now;

    // 현재 센서값 측정
    currentTemp = readTemperatureC();
    currentPackVoltage = readPackVoltage();
    currentCellAvg = currentPackVoltage / 3.0;
    currentCurrent = readCurrentA();

    // 변화율 및 내부저항 추정값 계산
    updateDerivedValues(dt);

    // 위험 점수 계산
    updateRiskScores();

    // 상태 판단 + 원인 분석
    updateStatus();

    // 출력 장치 제어
    updateOutputs();
    updateOLED();
    printSerialData();

    // 다음 루프를 위한 이전값 저장
    if (!isnan(currentTemp)) {
      prevTemp = currentTemp;
    }
    prevPackVoltage = currentPackVoltage;
  }

  // Flask 서버 전송 주기
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = now;
    sendDataToServer();
  }
}
