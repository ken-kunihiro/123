# -*- coding: utf-8 -*-
"""
freee認証モジュール（体験版・ブラウザ手動コピー方式／OOB）

freee APIを使うには「アクセストークン」が必要です。
このファイルは、ブラウザでfreeeにログインして許可すると表示される
「認可コード」を貼り付けてもらい、トークンを token.json に保存する
処理をまとめたものです（クラウド実行環境でも動くよう、ローカルサーバーで
コールバックを待ち受ける方式ではなく、OOB＝コードを画面に表示して
手動コピーする方式にしています）。

■ 初回の認証（当日一緒にやります・2ステップ）:
    1) python .claude/skills/setup/freee_auth.py
       → 認証用URLが表示されるので、ブラウザで開いてfreeeにログインし
         「許可する」を押してください。画面に認可コードが表示されます。
    2) python .claude/skills/setup/freee_auth.py --code <表示されたコード>
       → キットの一番上のフォルダに token.json が作られます。
         以降は auto_keiri.py などが自動で使います。

■ 事業所ID（company_id）の一覧を見たいとき:
    python .claude/skills/setup/freee_auth.py --companies
    （初回認証が済んでいる必要があります）

■ 他のスクリプト（auto_keiri.py / invoice_ocr.py）は、このファイルの
  get_access_token() を呼ぶだけでトークンを受け取れます。
  （期限切れなら自動でリフレッシュ。リフレッシュ不可なら、このファイルを
  上記の2ステップで実行し直すよう案内が出ます）

------------------------------------------------------------------------
【重要】freeeアプリ側の「コールバックURL」設定について
------------------------------------------------------------------------
freeeアプリの管理画面で、コールバックURLに次の値を"完全一致"で登録してください:

    urn:ietf:wg:oauth:2.0:oob

1文字でも違うと認証がエラーになります。README.mdの手順も参照してください。
"""

import os
import sys
import json
import time
import urllib.parse

import requests
from dotenv import load_dotenv

# --- Windowsで日本語が文字化けしないようにする（おまじない）-------------
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

# --- キットの一番上のフォルダ（.env / token.json はここに置きます）-------
# このファイルは .claude/skills/setup/ にあるので、3つ上がキットのルート。
KIT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)

load_dotenv(os.path.join(KIT_ROOT, ".env"))

# --- freeeの固定URL（変更不要）-----------------------------------------
AUTHORIZE_URL = "https://accounts.secure.freee.co.jp/public_api/authorize"
TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token"
API_BASE = "https://api.freee.co.jp/api/1"

# --- 認証の受け取り口（freeeアプリのコールバックURLと完全一致させること）---
# OOB方式: ローカルサーバーで待ち受けず、freee側の画面にコードを表示してもらう
REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"

# --- トークンの保存先（キットの一番上のフォルダの token.json）------------
# スキルごとにスクリプトが分かれているので、全スキルが同じ1つのトークンを
# 使えるよう、保存先はキットのルートに固定します。
TOKEN_FILE = os.path.join(KIT_ROOT, "token.json")


def _is_placeholder(v: str) -> bool:
    """未設定、またはひな形（.env.example）の仮の値のままかどうか"""
    return (not v) or v.startswith("あなたの") or ("xxxx" in v.lower())


def _client_id() -> str:
    v = os.environ.get("FREEE_CLIENT_ID", "").strip()
    if _is_placeholder(v):
        raise SystemExit("FREEE_CLIENT_ID が未設定（またはひな形のまま）です。.env を確認してください。")
    return v


def _client_secret() -> str:
    v = os.environ.get("FREEE_CLIENT_SECRET", "").strip()
    if _is_placeholder(v):
        raise SystemExit("FREEE_CLIENT_SECRET が未設定（またはひな形のまま）です。.env を確認してください。")
    return v


def _save_token(data: dict) -> None:
    # 取得時刻を足しておくと、期限切れ判定が楽になる
    data["_obtained_at"] = int(time.time())
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _load_token() -> dict | None:
    if not os.path.exists(TOKEN_FILE):
        return None
    with open(TOKEN_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _exchange_code(code: str) -> dict:
    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def _refresh_access_token(refresh_token: str) -> dict:
    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "refresh_token": refresh_token,
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def authorize_step1() -> str:
    """認証用URLを表示するだけ（OOB方式。コードはユーザーが画面から手動コピーする）"""
    query = urllib.parse.urlencode({
        "client_id": _client_id(),
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
    })
    url = f"{AUTHORIZE_URL}?{query}"

    print("次のURLをブラウザで開いて、freeeにログインし「許可する」を押してください。")
    print(url)
    print()
    print("ログイン後の画面に表示される「認可コード」をコピーして、")
    print("次のコマンドで --code に貼り付けて実行してください:")
    print("  python .claude/skills/setup/freee_auth.py --code <ここに認可コード>")
    return url


def authorize_step2(code: str) -> str:
    """ユーザーが貼り付けた認可コードをアクセストークンに交換する"""
    token_data = _exchange_code(code)
    _save_token(token_data)
    print("認証に成功しました。token.json を保存しました。")
    return token_data["access_token"]


def get_access_token() -> str:
    """
    有効なアクセストークンを返す。
    1) token.json があればリフレッシュを試す
    2) だめなら（または無ければ）再認証の手順を案内して終了する
       （このファイルを直接、--code 付きで実行し直してください）
    """
    token = _load_token()
    if token and token.get("refresh_token"):
        try:
            new_token = _refresh_access_token(token["refresh_token"])
            _save_token(new_token)
            return new_token["access_token"]
        except requests.HTTPError:
            print("トークンの更新に失敗しました。再認証が必要です。")
    authorize_step1()
    raise SystemExit(
        "再認証が必要です。上のURLで認証し、\n"
        "  python .claude/skills/setup/freee_auth.py --code <認可コード>\n"
        "を実行してから、もう一度お試しください。"
    )


# --- freee APIを呼ぶための小さな共通関数（他スクリプトからも使う）--------
def freee_get(path: str, token: str, params: dict | None = None) -> dict:
    resp = requests.get(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def freee_post(path: str, token: str, body: dict) -> dict:
    resp = requests.post(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    # エラー時はfreeeの返すメッセージも見せる（原因が分かりやすい）
    if resp.status_code >= 400:
        raise SystemExit(f"freee APIエラー ({resp.status_code}): {resp.text}")
    return resp.json()


if __name__ == "__main__":
    if "--code" in sys.argv:
        # 手順2: 認可コードをアクセストークンに交換する
        idx = sys.argv.index("--code")
        if idx + 1 >= len(sys.argv):
            raise SystemExit("--code の後に認可コードを指定してください。")
        authorize_step2(sys.argv[idx + 1])
        print("準備OKです。次は auto_keiri.py を試してみましょう。")
    elif "--companies" in sys.argv:
        # 事業所ID（company_id）の一覧を表示する
        tok = get_access_token()
        data = freee_get("/companies", tok)
        print("== 使える事業所の一覧 ==")
        for c in data.get("companies", []):
            print(f"  company_id={c['id']}  {c.get('display_name', '')}")
        print("↑ このうち、練習で使う事業所のIDを .env の FREEE_COMPANY_ID に設定してください。")
    else:
        # 手順1: 認証用URLを表示する（初回、またはリフレッシュ失敗時）
        token = _load_token()
        if token and token.get("refresh_token"):
            try:
                new_token = _refresh_access_token(token["refresh_token"])
                _save_token(new_token)
                print("トークンは有効です（自動更新しました）。準備OKです。")
                sys.exit(0)
            except requests.HTTPError:
                print("トークンの更新に失敗しました。再認証します。")
        authorize_step1()
