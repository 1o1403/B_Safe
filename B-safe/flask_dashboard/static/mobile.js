async function fetchLatestData() {
  try {
    const response = await fetch("/api/latest");
    const data = await response.json();
    updateMobile(data);
  } catch (error) {
    console.error("Mobile data fetch failed:", error);
  }
}

function updateMobile(data) {
  const temp = toNumber(data.temp);
  const tempRate = toNumber(data.temp_rate);
  const packVoltage = toNumber(data.pack_voltage);
  const cellAvg = toNumber(data.cell_avg);
  const current = toNumber(data.current);
  const status = data.status ?? "UNKNOWN";
  const message = data.message ?? "-";

  document.getElementById("statusValue").textContent = status;
  document.getElementById("messageValue").textContent = translateMessage(message);

  document.getElementById("tempValue").textContent = formatValue(temp, 1);
  document.getElementById("tempRateValue").textContent = formatValue(tempRate, 2);
  document.getElementById("packVoltageValue").textContent = formatValue(packVoltage, 2);
  document.getElementById("currentValue").textContent = formatValue(current, 2);
  document.getElementById("serverTimeValue").textContent = data.server_time ?? "--";

  const batteryPercent = estimateBatteryPercent(packVoltage);
  document.getElementById("batteryPercentValue").textContent = formatValue(batteryPercent, 0);

  const flightTime = estimateFlightTime(packVoltage, Math.abs(current));
  document.getElementById("flightTimeValue").textContent = formatValue(flightTime, 1);

  const riskPercent = calculateRiskPercent(
    temp,
    tempRate,
    packVoltage,
    cellAvg,
    Math.abs(current),
    status
  );

  document.getElementById("riskPercentValue").textContent = Math.round(riskPercent);

  drawRiskGauge(riskPercent);

  updateStatusStyle(status);
  updateDataCardStyle(status);
  updateReturnAndGPS(status, riskPercent);
}

function toNumber(value) {
  const n = Number(value);

  if (isNaN(n)) {
    return null;
  }

  return n;
}

function formatValue(value, digits) {
  if (value === null || value === undefined || isNaN(Number(value))) {
    return "--";
  }

  return Number(value).toFixed(digits);
}

function translateMessage(message) {
  const table = {
    "Normal": "정상 상태입니다.",
    "High temperature": "배터리 온도가 위험 수준입니다.",
    "Temperature rising fast": "온도가 빠르게 상승 중입니다.",
    "Pack voltage too low": "배터리 팩 전압이 너무 낮습니다.",
    "Pack over voltage": "배터리 팩 과전압 위험입니다.",
    "Over current": "과전류 위험이 감지되었습니다.",
    "Temperature warning": "배터리 온도 주의 상태입니다.",
    "Temperature rising": "온도 상승 속도가 증가하고 있습니다.",
    "Pack voltage low": "배터리 팩 전압이 낮습니다."
  };

  return table[message] ?? message;
}

function updateStatusStyle(status) {
  const riskBox = document.getElementById("riskBox");

  riskBox.classList.remove("normal", "warn", "danger");

  if (status === "NORMAL") {
    riskBox.classList.add("normal");
  } else if (status === "WARN") {
    riskBox.classList.add("warn");
  } else if (status === "DANGER") {
    riskBox.classList.add("danger");
  }
}

function updateDataCardStyle(status) {
  const cards = [
    "tempCard",
    "voltageCard",
    "currentCard",
    "tempRateCard",
    "flightTimeCard"
  ];

  cards.forEach(cardId => {
    const card = document.getElementById(cardId);

    if (!card) {
      return;
    }

    card.classList.remove("danger-data-card");

    if (status === "DANGER" || status === "위험") {
      card.classList.add("danger-data-card");
    }
  });
}

function estimateBatteryPercent(packVoltage) {
  // 3S 리튬이온 배터리 시연용 근사
  // Vmax = 12.6V, Vmin = 9.0V
  if (packVoltage === null || packVoltage === undefined) {
    return null;
  }

  const V_MAX = 12.6;
  const V_MIN = 9.0;

  const soc = (packVoltage - V_MIN) / (V_MAX - V_MIN);
  const batteryPercent = clamp(soc, 0, 1) * 100;

  return batteryPercent;
}

function estimateFlightTime(packVoltage, current) {
  // 잔여 비행시간 시연용 근사식
  // SOC = (V_pack - 9.0) / (12.6 - 9.0)
  // t_remaining[min] = (Capacity[Ah] × SOC / Current[A]) × 60

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

function calculateRiskPercent(temp, tempRate, packVoltage, cellAvg, current, status) {
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

  if (status === "WARN") {
    risk = Math.max(risk, 60);
  } else if (status === "DANGER") {
    risk = Math.max(risk, 85);
  } else if (status === "NORMAL") {
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

function updateReturnAndGPS(status, riskPercent) {
  const button = document.getElementById("returnButton");
  const gpsMain = document.getElementById("gpsMain");
  const gpsSub = document.getElementById("gpsSub");

  button.classList.remove("safe");

  if (status === "DANGER" || riskPercent >= 85) {
    button.textContent = "자동 복귀 필요";
    gpsMain.textContent = "가까운 안전 착륙 후보지 탐색 필요";
    gpsSub.textContent = "현재 시연에서는 GPS 착륙지점 안내는 발표용 확장 기능으로 표시합니다.";
  } else if (status === "WARN" || riskPercent >= 60) {
    button.textContent = "복귀 준비";
    gpsMain.textContent = "배터리 상태 주의. 복귀 준비 권장";
    gpsSub.textContent = "온도, 전압, 전류 상태를 계속 확인하세요.";
  } else {
    button.classList.add("safe");
    button.textContent = "정상 비행";
    gpsMain.textContent = "위험 상태가 아닙니다.";
    gpsSub.textContent = "위험 감지 시 가장 가까운 안전 착륙 후보지를 안내합니다.";
  }
}

function drawRiskGauge(percent) {
  const canvas = document.getElementById("riskGauge");
  const ctx = canvas.getContext("2d");

  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height * 0.9;
  const radius = width * 0.38;

  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;

  ctx.lineWidth = 18;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#374151";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.stroke();

  drawArcSegment(ctx, cx, cy, radius, 0, 35, "#22c55e");
  drawArcSegment(ctx, cx, cy, radius, 35, 70, "#facc15");
  drawArcSegment(ctx, cx, cy, radius, 70, 100, "#ef4444");

  const angle = Math.PI + (percent / 100) * Math.PI;
  const needleLength = radius * 0.9;

  const nx = cx + Math.cos(angle) * needleLength;
  const ny = cy + Math.sin(angle) * needleLength;

  ctx.strokeStyle = "#f9fafb";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.stroke();

  ctx.fillStyle = "#f9fafb";
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#e5e7eb";
  ctx.font = "15px Arial";
  ctx.textAlign = "center";

  if (percent < 60) {
    ctx.fillText("안전", cx, cy - 35);
  } else if (percent < 85) {
    ctx.fillText("주의", cx, cy - 35);
  } else {
    ctx.fillText("위험", cx, cy - 35);
  }
}

function drawArcSegment(ctx, cx, cy, radius, startPercent, endPercent, color) {
  const start = Math.PI + (startPercent / 100) * Math.PI;
  const end = Math.PI + (endPercent / 100) * Math.PI;

  ctx.strokeStyle = color;
  ctx.lineWidth = 18;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end);
  ctx.stroke();
}

setInterval(fetchLatestData, 1000);
fetchLatestData();