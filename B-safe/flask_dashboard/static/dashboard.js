// =====================================================
// B-SAFE Dashboard JS
// DANGER 발생 후 지도 화면 유지 + 센서값 갱신 + 착륙 완료 화면
// =====================================================


// =====================================================
// 0. 상태 변수
// =====================================================

let dangerScreenLocked = false;
let firstDangerData = null;

let landingComplete = false;
let landingTimerStarted = false;
let landingCompleteDelayMs = 14000;


// =====================================================
// 1. 상태 정규화
// =====================================================

function normalizeStatus(status) {
  const text = String(status ?? "READY").trim().toUpperCase();

  if (text === "DANGER" || text === "위험") {
    return "DANGER";
  }

  if (text === "WARN" || text === "WARNING" || text === "주의") {
    return "WARN";
  }

  if (text === "NORMAL" || text === "정상") {
    return "NORMAL";
  }

  if (text === "READY") {
    return "READY";
  }

  return text;
}


// =====================================================
// 2. DANGER / 착륙 완료 흐름 제어
// =====================================================

function lockDangerScreen(data) {
  if (dangerScreenLocked) {
    return;
  }

  dangerScreenLocked = true;
  firstDangerData = JSON.parse(JSON.stringify(data));

  console.log("DANGER screen locked. First danger data:", firstDangerData);

  if (!landingTimerStarted) {
    landingTimerStarted = true;

    setTimeout(() => {
      landingComplete = true;
      showLandingCompleteDashboard();
      console.log("Landing complete screen activated");
    }, landingCompleteDelayMs);
  }
}

function resetLandingFlow() {
  dangerScreenLocked = false;
  firstDangerData = null;
  landingComplete = false;
  landingTimerStarted = false;

  showNormalDashboard();

  fetch("/api/reset")
    .then(() => {
      fetchLatestData();
      fetchHistoryData();
    })
    .catch(error => {
      console.error("reset error:", error);
      fetchLatestData();
      fetchHistoryData();
    });
}


// =====================================================
// 3. Flask API 데이터 가져오기
// =====================================================

async function fetchLatestData() {
  try {
    const response = await fetch("/api/latest");
    const data = await response.json();

    updateDashboard(data);
  } catch (error) {
    console.error("latest data error:", error);
  }
}

async function fetchHistoryData() {
  try {
    const response = await fetch("/api/history");
    const history = await response.json();

    drawSimpleGraph("tempChart", history, "temp", 45, 60, false, "온도", "℃");
    drawSimpleGraph("tempRateChart", history, "temp_rate", 1.0, 2.0, false, "온도상승속도", "℃/s");
    drawSimpleGraph("voltageChart", history, "pack_voltage", 9.9, 9.0, false, "전압", "V");
    drawSimpleGraph("currentChart", history, "current", 2.0, 4.0, true, "전류", "A");
    drawSimpleGraph("voltageDropChart", history, "voltage_drop_rate", 0.03, 0.10, false, "전압하강속도", "V/s");
  } catch (error) {
    console.error("history data error:", error);
  }
}


// =====================================================
// 4. 메인 대시보드 업데이트
// =====================================================

function updateDashboard(data) {
  const incomingStatus = normalizeStatus(data.status);

  // DANGER 최초 발생 시 지도 화면 유지 시작
  if (incomingStatus === "DANGER") {
    lockDangerScreen(data);
  }

  const temp = toNumber(data.temp);
  const tempRate = toNumber(data.temp_rate);
  const packVoltage = toNumber(data.pack_voltage);
  const cellAvg = toNumber(data.cell_avg);
  const current = toNumber(data.current);
  const voltageDropRate = toNumber(data.voltage_drop_rate);
  const internalResistance = toNumber(data.internal_resistance);
  const status = incomingStatus;
  const message = data.message ?? "-";

  const eriPercentFromESP = toNumber(data.eri_percent);
  const riskPercent = eriPercentFromESP !== null
    ? eriPercentFromESP
    : calculateFallbackRiskPercent(
        temp,
        tempRate,
        packVoltage,
        cellAvg,
        Math.abs(current ?? 0),
        status
      );

  const batteryPercent = estimateBatteryPercent(packVoltage);
  const flightTime = estimateFlightTime(packVoltage, Math.abs(current ?? 0));
  const power = calcPower(packVoltage, current);

  const primaryCause = normalizeText(data.primary_cause, "-");
  const primaryScore = toNumber(data.primary_score);
  const secondaryCause = normalizeText(data.secondary_cause, "-");
  const secondaryScore = toNumber(data.secondary_score);
  const causeDetail = normalizeText(data.cause_detail, translateMessage(message));
  const statusTrigger = normalizeText(data.status_trigger, "-");

  if (landingComplete) {
    showLandingCompleteDashboard();
  } else if (dangerScreenLocked) {
    showDangerDashboard();
  } else if (status === "DANGER") {
    showDangerDashboard();
  } else {
    showNormalDashboard();
  }

  const payload = {
    temp,
    tempRate,
    packVoltage,
    cellAvg,
    current,
    voltageDropRate,
    internalResistance,
    status,
    message,
    riskPercent,
    batteryPercent,
    flightTime,
    power,
    primaryCause,
    primaryScore,
    secondaryCause,
    secondaryScore,
    causeDetail,
    statusTrigger,
    data
  };

  updateNormalDashboardValues(payload);
  updateDangerDashboardValues(payload);
  updateLandingCompleteValues(payload);
}


// =====================================================
// 5. 화면 전환
// =====================================================

function showNormalDashboard() {
  const normalDashboard = document.getElementById("normalDashboard");
  const dangerDashboard = document.getElementById("dangerDashboard");
  const landingCompleteDashboard = document.getElementById("landingCompleteDashboard");

  if (normalDashboard) {
    normalDashboard.style.display = "block";
  }

  if (dangerDashboard) {
    dangerDashboard.style.display = "none";
  }

  if (landingCompleteDashboard) {
    landingCompleteDashboard.style.display = "none";
  }
}

function showDangerDashboard() {
  const normalDashboard = document.getElementById("normalDashboard");
  const dangerDashboard = document.getElementById("dangerDashboard");
  const landingCompleteDashboard = document.getElementById("landingCompleteDashboard");

  if (normalDashboard) {
    normalDashboard.style.display = "none";
  }

  if (dangerDashboard) {
    dangerDashboard.style.display = "block";
  }

  if (landingCompleteDashboard) {
    landingCompleteDashboard.style.display = "none";
  }
}

function showLandingCompleteDashboard() {
  const normalDashboard = document.getElementById("normalDashboard");
  const dangerDashboard = document.getElementById("dangerDashboard");
  const landingCompleteDashboard = document.getElementById("landingCompleteDashboard");

  if (normalDashboard) {
    normalDashboard.style.display = "none";
  }

  if (dangerDashboard) {
    dangerDashboard.style.display = "none";
  }

  if (landingCompleteDashboard) {
    landingCompleteDashboard.style.display = "block";
  }
}


// =====================================================
// 6. 일반 화면 값 업데이트
// =====================================================

function updateNormalDashboardValues(payload) {
  setText("statusValue", payload.status);
  setText("riskPercentValue", formatValue(payload.riskPercent, 1));

  updateScoreCause(
    payload.primaryCause,
    payload.primaryScore,
    payload.secondaryCause,
    payload.secondaryScore,
    payload.status
  );

  setText("tempValue", formatValue(payload.temp, 1));
  setText("tempRateValue", formatValue(payload.tempRate, 2));
  setText("packVoltageValue", formatValue(payload.packVoltage, 2));
  setText("currentValue", formatValue(payload.current, 2));
  setText("voltageDropRateValue", formatValue(payload.voltageDropRate, 3));

  setText("batteryPercentValue", formatValue(payload.batteryPercent, 0));
  setText("flightTimeValue", formatValue(payload.flightTime, 1));
  setText("cellAvgValue", formatValue(payload.cellAvg, 2));
  setText("internalResistanceValue", formatValue(payload.internalResistance, 3));
  setText("powerValue", formatValue(payload.power, 1));

  updateEventLog(
    payload.data,
    payload.status,
    payload.statusTrigger,
    payload.causeDetail,
    payload.message
  );

  updateStatusColors(payload.status);
}


// =====================================================
// 7. 자동 복귀 지도 화면 값 업데이트
// 지도 화면은 유지, 왼쪽 값은 최신값으로 계속 갱신
// =====================================================

function updateDangerDashboardValues(payload) {
  setText("dangerTempValue", formatValue(payload.temp, 1));
  setText("dangerTempRateValue", formatValue(payload.tempRate, 2));
  setText("dangerPackVoltageValue", formatValue(payload.packVoltage, 2));
  setText("dangerCurrentValue", formatValue(payload.current, 2));
  setText("dangerVoltageDropRateValue", formatValue(payload.voltageDropRate, 3));
}


// =====================================================
// 8. 착륙 완료 화면 값 업데이트
// =====================================================

function updateLandingCompleteValues(payload) {
  setText("landingTempValue", formatValue(payload.temp, 1));
  setText("landingTempRateValue", formatValue(payload.tempRate, 2));
  setText("landingPackVoltageValue", formatValue(payload.packVoltage, 2));
  setText("landingCurrentValue", formatValue(payload.current, 2));

  const timeText = extractTimeText(payload.data.server_time);
  setText("landingTimeValue", timeText);
}


// =====================================================
// 9. 원인 표시 / 이벤트 로그
// =====================================================

function updateScoreCause(primaryCause, primaryScore, secondaryCause, secondaryScore, status) {
  const primaryValueEl = document.getElementById("scoreCauseValue");
  const primarySubEl = document.getElementById("scoreCauseSub");
  const secondaryValueEl = document.getElementById("secondaryCauseValue");
  const secondarySubEl = document.getElementById("secondaryCauseSub");

  if (primarySubEl) {
    primarySubEl.textContent = "";
    primarySubEl.style.display = "none";
  }

  if (secondarySubEl) {
    secondarySubEl.textContent = "";
    secondarySubEl.style.display = "none";
  }

  if (!primaryValueEl || !secondaryValueEl) {
    return;
  }

  if (status === "READY" || primaryCause === "-" || primaryScore === null) {
    primaryValueEl.textContent = "데이터 대기 중";
    secondaryValueEl.textContent = "-";
    return;
  }

  primaryValueEl.textContent = `${primaryCause} ${formatValue(primaryScore, 1)}점`;

  if (secondaryCause !== "-" && secondaryScore !== null) {
    secondaryValueEl.textContent = `${secondaryCause} ${formatValue(secondaryScore, 1)}점`;
  } else {
    secondaryValueEl.textContent = "보조 원인 없음";
  }
}

function updateEventLog(data, status, statusTrigger, causeDetail, message) {
  const time = data.server_time ?? "-";
  const eventLine = document.getElementById("eventLine");
  const eventDetail = document.getElementById("eventDetail");

  if (!eventLine || !eventDetail) {
    return;
  }

  if (status === "READY") {
    eventLine.textContent = "데이터 대기 중...";
    eventDetail.textContent = "ESP32 데이터 수신 후 원인 분석 정보가 표시됩니다.";
    return;
  }

  const triggerText = statusTrigger !== "-" ? statusTrigger : translateMessage(message);

  eventLine.textContent = `[${time}] ${status} - ${triggerText}`;
  eventDetail.textContent = causeDetail !== "-" ? causeDetail : translateMessage(message);
}


// =====================================================
// 10. 기본 유틸 함수
// =====================================================

function setText(id, value) {
  const element = document.getElementById(id);

  if (!element) {
    return;
  }

  element.textContent = value;
}

function toNumber(value) {
  const n = Number(value);

  if (value === null || value === undefined || isNaN(n)) {
    return null;
  }

  return n;
}

function normalizeText(value, defaultValue) {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  const text = String(value).trim();

  if (text.length === 0 || text === "null" || text === "undefined") {
    return defaultValue;
  }

  return text;
}

function formatValue(value, digits) {
  if (value === null || value === undefined || isNaN(Number(value))) {
    return "--";
  }

  return Number(value).toFixed(digits);
}

function extractTimeText(serverTime) {
  if (!serverTime || serverTime === "-") {
    const now = new Date();
    return now.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  const text = String(serverTime);
  const parts = text.split(" ");

  if (parts.length >= 2) {
    return parts[1];
  }

  return text;
}


// =====================================================
// 11. 상태 색상
// =====================================================

function updateStatusColors(status) {
  const normalizedStatus = normalizeStatus(status);

  const boxes = [
    "statusBox",
    "riskBox",
    "scoreCauseBox",
    "secondaryCauseBox",
    "tempBox",
    "tempRateBox",
    "voltageBox",
    "currentBox",
    "voltageDropBox",
    "batteryBox",
    "eventLogBox"
  ];

  boxes.forEach(id => {
    const box = document.getElementById(id);

    if (!box) {
      return;
    }

    box.classList.remove("normal-box", "warn-box", "danger-box");

    if (normalizedStatus === "NORMAL") {
      box.classList.add("normal-box");
    } else if (normalizedStatus === "WARN") {
      box.classList.add("warn-box");
    } else if (normalizedStatus === "DANGER") {
      box.classList.add("danger-box");
    }
  });
}


// =====================================================
// 12. 메시지 번역
// =====================================================

function translateMessage(message) {
  const table = {
    "Normal": "정상 상태",
    "High temperature": "온도 위험",
    "Temperature rising fast": "온도 급상승",
    "Pack voltage too low": "저전압 위험",
    "Pack over voltage": "팩 과전압 위험",
    "Over current": "과전류 위험",
    "Voltage drop rate danger": "전압 급락 위험",
    "Voltage sag danger": "전류 대비 전압강하 위험",
    "Temperature warning": "온도 주의",
    "Temperature rising": "온도상승 주의",
    "Pack voltage low": "전압 주의",
    "Voltage drop rate warning": "전압하강속도 주의",
    "Voltage sag warning": "전류 대비 전압강하 주의",
    "ERI warning": "ERI 누적 위험 주의",
    "ERI danger": "ERI 누적 위험",
    "테스트 데이터 수신 중": "테스트 데이터 수신 중"
  };

  return table[message] ?? message;
}


// =====================================================
// 13. 배터리 / 비행시간 / 전력 계산
// =====================================================

function estimateBatteryPercent(packVoltage) {
  if (packVoltage === null || packVoltage === undefined) {
    return null;
  }

  const V_MAX = 12.6;
  const V_MIN = 9.0;

  const soc = (packVoltage - V_MIN) / (V_MAX - V_MIN);
  return clamp(soc, 0, 1) * 100;
}

function estimateFlightTime(packVoltage, current) {
  if (
    packVoltage === null ||
    packVoltage === undefined ||
    current === null ||
    current === undefined ||
    current < 0.1
  ) {
    return null;
  }

  const V_MAX = 12.6;
  const V_MIN = 9.0;
  const CAPACITY_AH = 2.2;

  const soc = clamp((packVoltage - V_MIN) / (V_MAX - V_MIN), 0, 1);
  const remainingTimeMin = (CAPACITY_AH * soc / current) * 60;

  return clamp(remainingTimeMin, 0, 60);
}

function calcPower(packVoltage, current) {
  if (
    packVoltage === null ||
    packVoltage === undefined ||
    current === null ||
    current === undefined
  ) {
    return null;
  }

  return packVoltage * Math.abs(current);
}


// =====================================================
// 14. 위험도 보조 계산
// =====================================================

function calculateFallbackRiskPercent(temp, tempRate, packVoltage, cellAvg, current, status) {
  const normalizedStatus = normalizeStatus(status);

  let tempRisk = 0;
  let rateRisk = 0;
  let voltageRisk = 0;
  let currentRisk = 0;

  if (temp !== null) {
    tempRisk = mapClamp(temp, 30, 60, 0, 100);
  }

  if (tempRate !== null) {
    rateRisk = mapClamp(tempRate, 0, 2, 0, 100);
  }

  if (packVoltage !== null) {
    if (packVoltage <= 9.0) {
      voltageRisk = 100;
    } else if (packVoltage <= 9.9) {
      voltageRisk = mapClamp(packVoltage, 9.9, 9.0, 60, 100);
    } else if (packVoltage > 12.6) {
      voltageRisk = 100;
    } else {
      voltageRisk = mapClamp(packVoltage, 12.6, 9.9, 0, 60);
    }
  }

  if (current !== null) {
    currentRisk = mapClamp(current, 0, 4, 0, 100);
  }

  let risk = Math.max(tempRisk, rateRisk, voltageRisk, currentRisk);

  if (normalizedStatus === "WARN") {
    risk = Math.max(risk, 60);
  } else if (normalizedStatus === "DANGER") {
    risk = Math.max(risk, 85);
  } else if (normalizedStatus === "NORMAL") {
    risk = Math.min(risk, 50);
  }

  return clamp(risk, 0, 100);
}

function mapClamp(value, inMin, inMax, outMin, outMax) {
  if (inMin === inMax) {
    return outMin;
  }

  let ratio = (value - inMin) / (inMax - inMin);
  ratio = clamp(ratio, 0, 1);

  return outMin + ratio * (outMax - outMin);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


// =====================================================
// 15. 그래프 그리기
// =====================================================

function drawSimpleGraph(canvasId, history, field, warnLine, dangerLine, useAbs = false, yLabel = "값", unit = "") {
  const canvas = document.getElementById(canvasId);

  if (!canvas) {
    return;
  }

  const parent = canvas.parentElement;

  canvas.width = parent.clientWidth;
  canvas.height = parent.clientHeight;

  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!history || history.length < 2) {
    drawEmptyGraphFrame(ctx, canvas, yLabel, unit);
    return;
  }

  const values = history
    .map(item => Number(item[field]))
    .filter(value => !isNaN(value))
    .map(value => useAbs ? Math.abs(value) : value);

  if (values.length < 2) {
    drawEmptyGraphFrame(ctx, canvas, yLabel, unit);
    return;
  }

  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);

  if (warnLine !== null && warnLine !== undefined) {
    minValue = Math.min(minValue, warnLine);
    maxValue = Math.max(maxValue, warnLine);
  }

  if (dangerLine !== null && dangerLine !== undefined) {
    minValue = Math.min(minValue, dangerLine);
    maxValue = Math.max(maxValue, dangerLine);
  }

  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }

  const paddingLeft = 92;
  const paddingRight = 16;
  const paddingTop = 26;
  const paddingBottom = 26;

  const graphWidth = canvas.width - paddingLeft - paddingRight;
  const graphHeight = canvas.height - paddingTop - paddingBottom;

  drawGraphFrame(
    ctx,
    canvas,
    minValue,
    maxValue,
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
    graphWidth,
    graphHeight,
    yLabel,
    unit
  );

  drawThreshold(
    ctx,
    canvas,
    warnLine,
    minValue,
    maxValue,
    paddingLeft,
    paddingRight,
    paddingTop,
    graphHeight,
    "#f59e0b"
  );

  drawThreshold(
    ctx,
    canvas,
    dangerLine,
    minValue,
    maxValue,
    paddingLeft,
    paddingRight,
    paddingTop,
    graphHeight,
    "#dc2626"
  );

  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 2.5;
  ctx.beginPath();

  for (let i = 0; i < values.length; i++) {
    const x = paddingLeft + (i / (values.length - 1)) * graphWidth;
    const y = paddingTop + (1 - (values[i] - minValue) / (maxValue - minValue)) * graphHeight;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();

  const lastValue = values[values.length - 1];
  const lastX = paddingLeft + graphWidth;
  const lastY = paddingTop + (1 - (lastValue - minValue) / (maxValue - minValue)) * graphHeight;

  ctx.fillStyle = "#60a5fa";
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#e5e7eb";
  ctx.font = "11px Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(
    formatAxisValue(lastValue, unit),
    Math.max(paddingLeft + 60, lastX - 8),
    Math.max(paddingTop + 10, Math.min(canvas.height - paddingBottom - 10, lastY))
  );
}

function drawGraphFrame(
  ctx,
  canvas,
  minValue,
  maxValue,
  paddingLeft,
  paddingRight,
  paddingTop,
  paddingBottom,
  graphWidth,
  graphHeight,
  yLabel,
  unit
) {
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#374151";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(paddingLeft, paddingTop);
  ctx.lineTo(paddingLeft, canvas.height - paddingBottom);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(paddingLeft, canvas.height - paddingBottom);
  ctx.lineTo(canvas.width - paddingRight, canvas.height - paddingBottom);
  ctx.stroke();

  ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
  ctx.lineWidth = 1;

  for (let i = 1; i <= 3; i++) {
    const y = paddingTop + (graphHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(canvas.width - paddingRight, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#cbd5e1";
  ctx.font = "11px Arial";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  ctx.fillText(formatAxisValue(maxValue, unit), paddingLeft - 8, paddingTop);
  ctx.fillText(formatAxisValue(minValue, unit), paddingLeft - 8, canvas.height - paddingBottom);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("시간", paddingLeft + graphWidth / 2, canvas.height - 7);

  ctx.save();
  ctx.translate(16, paddingTop + graphHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function drawEmptyGraphFrame(ctx, canvas, yLabel, unit) {
  const paddingLeft = 92;
  const paddingRight = 16;
  const paddingTop = 26;
  const paddingBottom = 26;

  const graphWidth = canvas.width - paddingLeft - paddingRight;
  const graphHeight = canvas.height - paddingTop - paddingBottom;

  drawGraphFrame(
    ctx,
    canvas,
    0,
    1,
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
    graphWidth,
    graphHeight,
    yLabel,
    unit
  );

  ctx.fillStyle = "#9ca3af";
  ctx.font = "12px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("데이터 대기 중", paddingLeft + graphWidth / 2, paddingTop + graphHeight / 2);
}

function drawThreshold(ctx, canvas, value, minValue, maxValue, paddingLeft, paddingRight, paddingTop, graphHeight, color) {
  if (value === null || value === undefined) {
    return;
  }

  const y = paddingTop + (1 - (value - minValue) / (maxValue - minValue)) * graphHeight;

  ctx.strokeStyle = color;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.2;

  ctx.beginPath();
  ctx.moveTo(paddingLeft, y);
  ctx.lineTo(canvas.width - paddingRight, y);
  ctx.stroke();

  ctx.setLineDash([]);
}

function formatAxisValue(value, unit) {
  if (value === null || value === undefined || isNaN(Number(value))) {
    return `--${unit}`;
  }

  const number = Number(value);

  if (Math.abs(number) >= 100) {
    return `${number.toFixed(0)}${unit}`;
  }

  if (Math.abs(number) >= 10) {
    return `${number.toFixed(1)}${unit}`;
  }

  return `${number.toFixed(2)}${unit}`;
}


// =====================================================
// 16. 주기 실행
// =====================================================

setInterval(() => {
  fetchLatestData();
  fetchHistoryData();
}, 1000);

fetchLatestData();
fetchHistoryData();