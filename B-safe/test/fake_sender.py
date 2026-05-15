import requests
import time
import random

URL = "http://127.0.0.1:5000/api/data"

t = 0

while True:
    temp = 35 + random.random() * 10
    temp_rate = random.random()

    data = {
        "time": t,
        "temp": round(temp, 2),
        "temp_rate": round(temp_rate, 2),
        "cell1": round(3.7 + random.random() * 0.05, 2),
        "cell2": round(3.7 + random.random() * 0.05, 2),
        "cell3": round(3.7 + random.random() * 0.05, 2),
        "pack_voltage": round(11.1 + random.random() * 0.1, 2),
        "current": round(1.0 + random.random(), 2),
        "status": "NORMAL",
        "message": "테스트 데이터 수신 중"
    }

    requests.post(URL, json=data)
    print(data)

    t += 1
    time.sleep(1)