"""
Weekly backup script for the Reports app (reports.sramesh.in).

Signs in to Firebase using an email/password "backup-bot" account
(no admin service-account key needed), fetches the entire
`importReports` node from the Realtime Database, and saves it as a
timestamped JSON file under backups/. Also prunes old backups,
keeping only the most recent 12 (~3 months of weekly runs).
"""

import json
import os
import glob
import datetime
import requests

FIREBASE_API_KEY = "AIzaSyCemVHrdqncmTUDnR4KwLr-nb4_lmdMD6w"
DB_URL = "https://reports-project-e8f66-default-rtdb.asia-southeast1.firebasedatabase.app"
ROOT = "importReports"
KEEP_LAST_N = 12

BACKUP_EMAIL = os.environ["BACKUP_EMAIL"]
BACKUP_PASSWORD = os.environ["BACKUP_PASSWORD"]


def _auth_call(endpoint):
    url = (
        f"https://identitytoolkit.googleapis.com/v1/accounts:{endpoint}"
        f"?key={FIREBASE_API_KEY}"
    )
    return requests.post(
        url,
        json={
            "email": BACKUP_EMAIL,
            "password": BACKUP_PASSWORD,
            "returnSecureToken": True,
        },
        timeout=30,
    )


def _reason(resp):
    try:
        return resp.json().get("error", {}).get("message", "unknown")
    except ValueError:
        return "unknown"


def sign_in():
    """Sign the backup bot in, creating its account on the very first run.

    This used to sign in as Ramesh. That tied the weekly backup to a password
    a person changes from time to time, and when it changed the backup simply
    stopped — quietly, for weeks. The bot now has an account of its own, so
    nothing a person does to their own login can break it.
    """
    resp = _auth_call("signInWithPassword")
    if resp.status_code == 200:
        return resp.json()["idToken"]

    print(f"Sign-in did not succeed ({_reason(resp)}). Trying to create the backup account.")
    resp = _auth_call("signUp")
    if resp.status_code == 200:
        print("Backup account created.")
        return resp.json()["idToken"]

    reason = _reason(resp)
    if reason == "EMAIL_EXISTS":
        raise SystemExit(
            "The backup account exists but the password does not match. "
            "Update the BACKUP_PASSWORD secret, or delete the account in "
            "Firebase Authentication and run this again to recreate it."
        )
    print("Firebase auth failed. Response body:")
    print(resp.text)
    raise SystemExit(f"Could not sign in or sign up: {reason}")


def fetch_data(id_token):
    url = f"{DB_URL}/{ROOT}.json?auth={id_token}"
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    return resp.json()


# This repository is public, so anything committed here is readable by
# anyone. The member list holds real email addresses and is not worth
# restoring anyway: accounts live in Firebase Auth, and the first person to
# sign up becomes the admin again.
DO_NOT_BACK_UP = ("members", "users")


def strip_personal(data):
    if not isinstance(data, dict):
        return data, []
    dropped = [k for k in DO_NOT_BACK_UP if k in data]
    for key in dropped:
        del data[key]
    return data, dropped


def save_backup(data):
    os.makedirs("backups", exist_ok=True)
    today = datetime.date.today().isoformat()
    path = f"backups/reports-backup-{today}.json"

    data, dropped = strip_personal(data)
    if not data:
        raise SystemExit("Nothing left to back up, refusing to write an empty file.")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Backup saved: {path}")
    print("Nodes backed up:", ", ".join(sorted(data)))
    if dropped:
        print("Left out on purpose:", ", ".join(dropped))


def prune_old_backups():
    files = sorted(glob.glob("backups/reports-backup-*.json"))
    if len(files) > KEEP_LAST_N:
        for old_file in files[: len(files) - KEEP_LAST_N]:
            os.remove(old_file)
            print(f"Removed old backup: {old_file}")


def main():
    id_token = sign_in()
    data = fetch_data(id_token)
    save_backup(data)
    prune_old_backups()


if __name__ == "__main__":
    main()
