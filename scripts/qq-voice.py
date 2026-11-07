#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qq-voice.py —— 把一个本地 wav 通过 dsh-qqbot 的机器人账号发成 QQ 语音。

由 dsh-feiyu-voice 插件调用（插件负责合成 wav），也可以手动用：

    python qq-voice.py --wav out.wav [--target c2c:<openid> | --group <群openid>]
                       [--content "附带文字"] [--msg-id <被动回复的消息id>]
                       [--config <cordis.patch.yml>]

凭据来源（按优先级）：
  1. --config 指定的 cordis.patch.yml
  2. 环境变量 DSH_QQBOT_CONFIG 指向的文件
  3. ~/.dsh/profiles/<DSH_PROFILE 或 desktop>/cordis.patch.yml 里的 `- id: im-qqbot` 段

脚本不打印 appSecret / access_token。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
API_BASE = "https://api.sgroup.qq.com"
MEDIA_VOICE = 3


def _unquote(v: str) -> str:
    v = v.strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" else v


def default_config_path() -> Path:
    home = Path.home()
    profile = os.environ.get("DSH_PROFILE") or "desktop"
    return home / ".dsh" / "profiles" / profile / "cordis.patch.yml"


def read_qqbot_config(path: Path) -> dict:
    if not path.is_file():
        return {}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    start = next((i for i, l in enumerate(lines) if re.match(r"^-\s*id:\s*im-qqbot\b", l.strip())), None)
    if start is None:
        return {}
    block = []
    for line in lines[start + 1:]:
        if re.match(r"^-\s*id:", line.strip()):
            break
        block.append(line)
    cfg = {"app_id": "", "app_secret": "", "c2c_allow": [], "group_allow": []}
    section = None
    for line in block:
        s = line.strip()
        if m := re.match(r"^appId:\s*(.+)$", s):
            cfg["app_id"] = _unquote(m.group(1))
            continue
        if m := re.match(r"^appSecret:\s*(.+)$", s):
            cfg["app_secret"] = _unquote(m.group(1))
            continue
        if m := re.match(r"^(c2cAllow|groupAllow):\s*(.*)$", s):
            section = m.group(1)
            inline = m.group(2).strip()
            if inline.startswith("[") and inline.endswith("]"):
                items = [x.strip().strip("'\"") for x in inline[1:-1].split(",") if x.strip()]
                cfg["c2c_allow" if section == "c2cAllow" else "group_allow"] = items
            continue
        if m := re.match(r"^-\s*(\S+)\s*$", s):
            if section == "c2cAllow":
                cfg["c2c_allow"].append(m.group(1).strip("'\""))
            elif section == "groupAllow":
                cfg["group_allow"].append(m.group(1).strip("'\""))
            continue
        if s and not line.startswith((" ", "\t")):
            section = None
    return cfg


def http_json(method: str, url: str, body: dict | None = None, token: str | None = None, timeout: int = 30) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"QQBot {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw)
        except json.JSONDecodeError:
            detail = {"raw": raw[:400]}
        raise RuntimeError(f"HTTP {e.code} -> {detail}") from None


def get_token(app_id: str, app_secret: str) -> str:
    out = http_json("POST", TOKEN_URL, {"appId": app_id, "clientSecret": app_secret})
    tok = out.get("access_token") or out.get("accessToken")
    if not tok:
        raise RuntimeError(f"拿不到 access_token：{out}")
    return tok


def upload_voice(token: str, scope: str, target: str, wav: Path) -> str:
    blob = wav.read_bytes()
    seg = "users" if scope == "c2c" else "groups"
    body = {
        "file_type": MEDIA_VOICE,
        "srv_send_msg": False,
        "file_data": base64.b64encode(blob).decode("ascii"),
    }
    out = http_json("POST", f"{API_BASE}/v2/{seg}/{target}/files", body, token)
    info = out.get("file_info")
    if not info:
        raise RuntimeError(f"上传失败：{out}")
    return info


def send_media(token: str, scope: str, target: str, file_info: str, content: str, msg_id: str) -> dict:
    seg = "users" if scope == "c2c" else "groups"
    body = {"msg_type": 7, "media": {"file_info": file_info}, "msg_seq": 1}
    if content:
        body["content"] = content
    if msg_id:
        body["msg_id"] = msg_id
    return http_json("POST", f"{API_BASE}/v2/{seg}/{target}/messages", body, token)


def main() -> int:
    ap = argparse.ArgumentParser(description="把本地 wav 发成 QQ 语音")
    ap.add_argument("--wav", required=True, help="要发送的 wav 文件")
    ap.add_argument("--target", help="c2c:<openid>；不填用白名单第一个")
    ap.add_argument("--group", help="群 openid（与 --target 二选一）")
    ap.add_argument("--content", default="", help="附带文字（可选）")
    ap.add_argument("--msg-id", default="", help="被动回复的消息 id（不占主动额度）")
    ap.add_argument("--config", default=os.environ.get("DSH_QQBOT_CONFIG", ""), help="cordis.patch.yml 路径")
    args = ap.parse_args()

    wav = Path(args.wav).expanduser()
    if not wav.is_file():
        print(f"wav 不存在：{wav}", file=sys.stderr)
        return 2
    if wav.stat().st_size > 20 * 1024 * 1024:
        print("wav 超过 20 MB，QQ 单次上传会失败", file=sys.stderr)
        return 2

    cfg = read_qqbot_config(Path(args.config) if args.config else default_config_path())
    app_id = os.environ.get("QQBOT_APP_ID") or cfg.get("app_id", "")
    app_secret = os.environ.get("QQBOT_APP_SECRET") or cfg.get("app_secret", "")

    if args.group:
        scope, target = "group", args.group
    elif args.target:
        scope, target = ("group" if args.target.startswith("group:") else "c2c"), args.target.split(":", 1)[-1]
    else:
        allow = cfg.get("c2c_allow") or []
        if not allow:
            print("没给 --target/--group，且 qqbot 白名单里没有 c2c openid", file=sys.stderr)
            return 2
        scope, target = "c2c", allow[0]

    if not app_id or not app_secret:
        print("缺 QQ 机器人 appId/appSecret：检查 cordis.patch.yml 的 im-qqbot 段", file=sys.stderr)
        return 2

    token = get_token(app_id, app_secret)
    info = upload_voice(token, scope, target, wav)
    out = send_media(token, scope, target, info, args.content, args.msg_id)
    print(json.dumps({"ok": True, "sent_as": str(wav), "message_id": out.get("id")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        print(f"失败：{e}", file=sys.stderr)
        sys.exit(1)
