import json
import os
import re
import urllib.error
import urllib.request

BASE = os.environ.get("NEXT_PUBLIC_BASE_URL", "http://localhost:3000").rstrip("/") + "/api"


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return exc.code, payload


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("PASS:", message)


def main():
    players = [{"name": "Aarav Mehta"}, {"name": "Diya Shah"}, {"name": "Kabir Rao"}, {"name": "Ishita Nair"}]
    status, payload = call("POST", "/games", {"gameName": "Friday Teen Patti", "baseAmount": 10, "totalGames": 2, "players": players})
    check(status == 201, "POST /api/games creates a session")
    game = payload["game"]
    token = payload["hostToken"]
    code = game["gameCode"]
    game_id = game["_id"]
    check(re.fullmatch(r"[0-9a-f-]{36}", game_id), "created game has UUID id")
    check(re.fullmatch(r"TP-[A-Z2-9]{5}", code), "created game has game code")
    check(token and "hostToken" not in game, "creation returns token but public game omits it")

    status, listing = call("GET", "/games")
    check(status == 200 and any(row.get("gameCode") == code for row in listing["games"]), "GET /api/games lists created session")
    check(all("hostToken" not in row for row in listing["games"]), "list never exposes host tokens")

    status, by_code = call("GET", "/games/" + code)
    check(status == 200 and by_code["game"]["_id"] == game_id and "hostToken" not in by_code["game"], "GET /api/games/:gameCode returns game without host token")
    status, legacy = call("GET", "/" + code)
    check(status == 200 and legacy["game"]["gameCode"] == code and "hostToken" not in legacy["game"], "legacy /api/:gameCode remains harmless")

    status, _ = call("POST", "/games/" + code + "/start", {})
    check(status == 403, "host authorization rejects missing token")
    status, started = call("POST", "/games/" + code + "/start", {"hostToken": token})
    check(status == 200 and started["game"]["status"] == "active", "host starts session")
    p1, p2, p3, p4 = [player["id"] for player in started["game"]["players"]]

    status, _ = call("POST", "/games/" + code + "/action", {"hostToken": token, "actionType": "PLAY", "playerId": p1, "amount": 15})
    check(status == 200, "PLAY action succeeds")
    status, _ = call("POST", "/games/" + code + "/pack", {"hostToken": token, "playerId": p4})
    check(status == 200, "PACK action succeeds")
    status, _ = call("POST", "/games/" + code + "/action", {"hostToken": token, "actionType": "PLAY", "playerId": p4, "amount": 25})
    check(400 <= status < 500, "PLAY on packed player is rejected")
    status, finished = call("POST", "/games/" + code + "/finish-round", {"hostToken": token, "winnerId": p1})
    check(status == 200 and finished["game"]["rounds"][0]["status"] == "complete", "finish round succeeds")

    status, summary = call("GET", "/games/" + code + "/summary")
    check(status == 200 and summary["summary"]["gamesCompleted"] == 1, "GET /api/games/:id/summary works")
    status, settlement = call("GET", "/games/" + code + "/settlement")
    result = settlement["settlement"]
    check(status == 200 and result["gamesCompleted"] == 1 and result["isBalanced"] and result["discrepancy"] == 0, "GET /api/games/:id/settlement works and balances")
    status, public_after = call("GET", "/games/" + game_id)
    check(status == 200 and "hostToken" not in public_after["game"], "public GET by id never exposes host token")
    print("ALL BACKEND CONTRACT TESTS PASSED")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("FINDING:", exc)
        raise
