from flask import Flask, request, jsonify, render_template
from datetime import datetime
import csv
import os

app = Flask(__name__)

# =====================================================
# 1. 기본 설정
# =====================================================

DATA_DIR = "data"
CSV_FILE = os.path.join(DATA_DIR, "bsafe_log.csv")

os.makedirs(DATA_DIR, exist_ok=True)

# ESP32에서 보내는 기존 센서값 + ERI/원인분석 필드까지 저장
CSV_FIELDS = [
    "server_time",
    "time",

    # 기본 센서값
    "temp",
    "temp_rate",
    "cell1",
    "cell2",
    "cell3",
    "pack_voltage",
    "cell_avg",
    "current",

    # 새로 추가된 전압 변화/내부저항 추정값
    "voltage_rate",
    "voltage_drop_rate",
    "voltage_sag",
    "internal_resistance",

    # 개별 위험 점수, 각 0~100점
    "temp_score",
    "temp_rate_score",
    "voltage_score",
    "voltage_rate_score",
    "resistance_score",
    "current_score",

    # ERI 점수
    "eri_raw_sum",     # 0~600, 6개 점수 단순합
    "eri",             # 0~1000, 내부 계산용
    "eri_percent",     # 0.0~100.0, 화면 표시용

    # 원인 분석 정보
    "primary_cause",
    "primary_score",
    "secondary_cause",
    "secondary_score",
    "status_trigger",
    "cause_detail",
    "cause_list",

    # 상태 정보
    "status",
    "message"
]

# 최근 데이터 저장 개수
MAX_HISTORY = 300


def make_default_data():
    """서버 시작/초기화 시 사용하는 기본 데이터"""
    return {
        "server_time": "-",
        "time": 0.0,

        "temp": None,
        "temp_rate": 0.0,
        "cell1": 0.0,
        "cell2": 0.0,
        "cell3": 0.0,
        "pack_voltage": 0.0,
        "cell_avg": 0.0,
        "current": 0.0,

        "voltage_rate": 0.0,
        "voltage_drop_rate": 0.0,
        "voltage_sag": 0.0,
        "internal_resistance": 0.0,

        "temp_score": 0.0,
        "temp_rate_score": 0.0,
        "voltage_score": 0.0,
        "voltage_rate_score": 0.0,
        "resistance_score": 0.0,
        "current_score": 0.0,

        "eri_raw_sum": 0.0,
        "eri": 0.0,
        "eri_percent": 0.0,

        "primary_cause": "-",
        "primary_score": 0.0,
        "secondary_cause": "-",
        "secondary_score": 0.0,
        "status_trigger": "-",
        "cause_detail": "Waiting for ESP32 data",
        "cause_list": "",

        "status": "READY",
        "message": "Waiting for ESP32 data"
    }


# 최신 데이터 기본값
latest_data = make_default_data()

# 그래프용 히스토리 데이터
history_data = []


# =====================================================
# 2. CSV 초기화
# =====================================================

def init_csv():
    """
    CSV 파일 초기화.
    기존 CSV가 예전 헤더 형식이면 백업 후 새 헤더로 다시 시작한다.
    """
    if not os.path.exists(CSV_FILE) or os.path.getsize(CSV_FILE) == 0:
        write_csv_header()
        return

    try:
        with open(CSV_FILE, mode="r", newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            old_header = next(reader, [])
    except Exception:
        old_header = []

    if old_header != CSV_FIELDS:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(DATA_DIR, f"bsafe_log_backup_{timestamp}.csv")
        os.replace(CSV_FILE, backup_file)
        write_csv_header()
        print(f"[CSV] Existing CSV schema changed. Old file backed up to: {backup_file}")


def write_csv_header():
    with open(CSV_FILE, mode="w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()


# =====================================================
# 3. 보조 함수
# =====================================================

def to_float(value, default=0.0):
    try:
        if value is None:
            return default
        return float(value)
    except (ValueError, TypeError):
        return default


def to_float_or_none(value):
    try:
        if value is None:
            return None
        return float(value)
    except (ValueError, TypeError):
        return None


def to_str(value, default="-"):
    if value is None:
        return default

    if isinstance(value, list):
        return ", ".join(str(item) for item in value)

    if isinstance(value, dict):
        return str(value)

    return str(value)


def clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))


def get_first(data, keys, default=None):
    """여러 후보 키 중 가장 먼저 존재하는 값을 반환"""
    for key in keys:
        if key in data and data.get(key) is not None:
            return data.get(key)
    return default


def normalize_data(data):
    """
    ESP32에서 받은 JSON 데이터를 Flask 서버 기준 형식으로 정리.
    서버는 위험도를 새로 판단하지 않고, ESP32가 보낸 값을 저장/전달하는 역할을 한다.
    """

    server_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 기본 센서값
    temp = to_float_or_none(data.get("temp"))
    temp_rate = to_float(data.get("temp_rate"), 0.0)

    cell1 = to_float(data.get("cell1"), 0.0)
    cell2 = to_float(data.get("cell2"), 0.0)
    cell3 = to_float(data.get("cell3"), 0.0)

    pack_voltage = to_float(data.get("pack_voltage"), 0.0)

    # cell_avg가 없으면 cell1~cell3 값으로 보조 계산
    cell_avg_from_esp = data.get("cell_avg")
    if cell_avg_from_esp is not None:
        cell_avg = to_float(cell_avg_from_esp, 0.0)
    elif cell1 > 0 and cell2 > 0 and cell3 > 0:
        cell_avg = (cell1 + cell2 + cell3) / 3.0
    elif pack_voltage > 0:
        cell_avg = pack_voltage / 3.0
    else:
        cell_avg = 0.0

    current = to_float(data.get("current"), 0.0)

    # 전압 변화/전압강하/내부저항 추정값
    voltage_rate = to_float(data.get("voltage_rate"), 0.0)
    voltage_drop_rate = to_float(data.get("voltage_drop_rate"), max(0.0, -voltage_rate))
    voltage_sag = to_float(data.get("voltage_sag"), 0.0)

    internal_resistance = to_float(
        get_first(data, ["internal_resistance", "resistance", "r_est"]),
        0.0
    )

    # 개별 위험 점수
    temp_score = to_float(data.get("temp_score"), 0.0)
    temp_rate_score = to_float(data.get("temp_rate_score"), 0.0)
    voltage_score = to_float(data.get("voltage_score"), 0.0)
    voltage_rate_score = to_float(data.get("voltage_rate_score"), 0.0)
    resistance_score = to_float(
        get_first(data, ["resistance_score", "voltage_sag_score"]),
        0.0
    )
    current_score = to_float(data.get("current_score"), 0.0)

    score_sum = (
        temp_score
        + temp_rate_score
        + voltage_score
        + voltage_rate_score
        + resistance_score
        + current_score
    )

    # ERI: ESP32가 보낸 값을 우선 사용하고, 없으면 서버에서 보조 계산만 수행
    eri_raw_sum = to_float(data.get("eri_raw_sum"), score_sum)

    eri_from_esp = data.get("eri")
    if eri_from_esp is not None:
        eri = to_float(eri_from_esp, 0.0)
    else:
        eri = (eri_raw_sum / 600.0) * 1000.0

    eri = clamp(eri, 0.0, 1000.0)

    eri_percent_from_esp = data.get("eri_percent")
    if eri_percent_from_esp is not None:
        eri_percent = to_float(eri_percent_from_esp, 0.0)
    else:
        eri_percent = eri / 10.0

    eri_percent = clamp(eri_percent, 0.0, 100.0)

    new_data = {
        "server_time": server_time,
        "time": to_float(data.get("time"), 0.0),

        "temp": temp,
        "temp_rate": temp_rate,
        "cell1": cell1,
        "cell2": cell2,
        "cell3": cell3,
        "pack_voltage": pack_voltage,
        "cell_avg": cell_avg,
        "current": current,

        "voltage_rate": voltage_rate,
        "voltage_drop_rate": voltage_drop_rate,
        "voltage_sag": voltage_sag,
        "internal_resistance": internal_resistance,

        "temp_score": temp_score,
        "temp_rate_score": temp_rate_score,
        "voltage_score": voltage_score,
        "voltage_rate_score": voltage_rate_score,
        "resistance_score": resistance_score,
        "current_score": current_score,

        "eri_raw_sum": eri_raw_sum,
        "eri": eri,
        "eri_percent": eri_percent,

        "primary_cause": to_str(data.get("primary_cause"), "-"),
        "primary_score": to_float(data.get("primary_score"), 0.0),
        "secondary_cause": to_str(data.get("secondary_cause"), "-"),
        "secondary_score": to_float(data.get("secondary_score"), 0.0),
        "status_trigger": to_str(data.get("status_trigger"), "-"),
        "cause_detail": to_str(data.get("cause_detail"), "-"),
        "cause_list": to_str(data.get("cause_list"), ""),

        "status": to_str(data.get("status"), "UNKNOWN"),
        "message": to_str(data.get("message"), "No message")
    }

    return new_data


def save_to_csv(data):
    with open(CSV_FILE, mode="a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writerow(data)


# =====================================================
# 4. 화면 라우트
# =====================================================

@app.route("/")
def home():
    return render_template("dashboard.html")


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


@app.route("/mobile")
def mobile():
    return render_template("mobile.html")


# =====================================================
# 5. ESP32 데이터 수신 API
# =====================================================

@app.route("/api/data", methods=["POST"])
def receive_data():
    global latest_data, history_data

    data = request.get_json(silent=True)

    if data is None:
        return jsonify({
            "ok": False,
            "error": "No JSON data received"
        }), 400

    new_data = normalize_data(data)

    latest_data = new_data
    history_data.append(new_data)

    if len(history_data) > MAX_HISTORY:
        history_data = history_data[-MAX_HISTORY:]

    save_to_csv(new_data)

    print("[ESP32 DATA]", new_data)

    return jsonify({
        "ok": True,
        "message": "Data received"
    }), 200


# =====================================================
# 6. 최신 데이터 제공 API
# dashboard.js / mobile.js가 사용
# =====================================================

@app.route("/api/latest", methods=["GET"])
def get_latest():
    return jsonify(latest_data)


# =====================================================
# 7. 그래프용 히스토리 데이터 제공 API
# dashboard.js가 사용
# =====================================================

@app.route("/api/history", methods=["GET"])
def get_history():
    return jsonify(history_data)


# =====================================================
# 8. 서버 상태 확인용 API
# =====================================================

@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({
        "ok": True,
        "message": "B-SAFE Flask server is running",
        "history_count": len(history_data),
        "csv_file": CSV_FILE,
        "max_history": MAX_HISTORY,
        "csv_fields": CSV_FIELDS
    })


# =====================================================
# 9. 히스토리 초기화 API
# 필요할 때 브라우저에서 /api/reset 접속하면 그래프 데이터 초기화
# CSV 파일은 삭제하지 않음
# =====================================================

@app.route("/api/reset", methods=["GET", "POST"])
def reset_history():
    global history_data, latest_data

    history_data = []
    latest_data = make_default_data()

    return jsonify({
        "ok": True,
        "message": "History data reset complete"
    })


# =====================================================
# 10. 서버 실행
# =====================================================

if __name__ == "__main__":
    init_csv()

    print("====================================")
    print("B-SAFE Flask Server Started")
    print("Local Dashboard:")
    print("  http://127.0.0.1:5000/dashboard")
    print("Local Mobile:")
    print("  http://127.0.0.1:5000/mobile")
    print()
    print("Network Access:")
    print("  http://<노트북IP>:5000/dashboard")
    print("  http://<노트북IP>:5000/mobile")
    print()
    print("ESP32 POST URL:")
    print("  http://<노트북IP>:5000/api/data")
    print("====================================")

    app.run(host="0.0.0.0", port=5000, debug=True)
