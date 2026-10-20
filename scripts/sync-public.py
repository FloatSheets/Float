#!/usr/bin/env python3
"""Publish a public-identity mirror of main without changing the private branch."""

from __future__ import annotations

import os
import re
import subprocess
import sys

SOURCE_BRANCH = "main"
PUBLIC_BRANCH = "public-main"
PUBLIC_REMOTE = "public-origin"
PUBLIC_NAME = "FloatSheets"
PUBLIC_EMAIL = "floatsheetsrh@atomicmail.io"
EXCLUDED_PATH = b".lovable"
PUSH_BATCH_SIZE = 4


def run(*args: str, input_data: bytes | None = None) -> bytes:
    environment = os.environ.copy()
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["GCM_INTERACTIVE"] = "never"
    completed = subprocess.run(
        list(args),
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    if completed.returncode:
        sys.stderr.buffer.write(completed.stderr)
        raise SystemExit(completed.returncode)
    return completed.stdout


def rewritten_identity(line: bytes) -> bytes:
    match = re.match(rb"^(author|committer|tagger) .*? ([-]?\d+ [+-]\d{4})\n$", line)
    if not match:
        return line
    return (
        match.group(1)
        + b" "
        + PUBLIC_NAME.encode()
        + b" <"
        + PUBLIC_EMAIL.encode()
        + b"> "
        + match.group(2)
        + b"\n"
    )


def scrub_commit_message(payload: bytes) -> bytes:
    """Remove co-author trailers while preserving the rest of each message."""
    return re.sub(rb"(?im)^co-authored-by:[^\r\n]*(?:\r?\n|$)", b"", payload)


def excluded_path_command(line: bytes) -> bool:
    """Exclude Lovable project metadata from every public commit tree."""
    if not line.startswith((b"M ", b"D ", b"R ", b"C ")):
        return False
    # The .lovable path has no spaces, so fast-export writes it without quoting.
    return any(
        path == EXCLUDED_PATH or path.startswith(EXCLUDED_PATH + b"/")
        for path in line.strip().split()[1:]
    )


def rewrite_export(stream: bytes) -> bytes:
    """Rewrite fast-export headers while copying opaque data payloads unchanged."""
    output = bytearray()
    cursor = 0
    record_kind: bytes | None = None
    while cursor < len(stream):
        newline = stream.find(b"\n", cursor)
        if newline == -1:
            output.extend(stream[cursor:])
            break
        line = stream[cursor : newline + 1]
        cursor = newline + 1
        if excluded_path_command(line):
            continue
        if line == b"blob\n":
            record_kind = b"blob"
        elif line.startswith(b"commit "):
            record_kind = b"commit"
        elif line.startswith(b"tag "):
            record_kind = b"tag"
        if line.startswith(b"data "):
            try:
                size = int(line[5:-1])
            except ValueError as error:
                raise RuntimeError(f"Unexpected fast-export data directive: {line!r}") from error
            payload = stream[cursor : cursor + size]
            cursor += size
            if record_kind in (b"commit", b"tag"):
                payload = scrub_commit_message(payload)
                output.extend(f"data {len(payload)}\n".encode())
            else:
                output.extend(line)
            output.extend(payload)
            if cursor < len(stream) and stream[cursor : cursor + 1] == b"\n":
                output.extend(b"\n")
                cursor += 1
            continue
        if line in (b"commit refs/heads/main\n", b"reset refs/heads/main\n"):
            output.extend(
                line.replace(
                    b"refs/heads/main",
                    f"refs/heads/{PUBLIC_BRANCH}".encode(),
                )
            )
        else:
            output.extend(rewritten_identity(line))
    return bytes(output)


def main() -> None:
    run("git", "rev-parse", "--verify", SOURCE_BRANCH)
    source_commit = run("git", "rev-parse", SOURCE_BRANCH).decode().strip()
    exported = run("git", "fast-export", "--show-original-ids", SOURCE_BRANCH)
    run("git", "fast-import", "--force", input_data=rewrite_export(exported))
    public_commit = run("git", "rev-parse", f"refs/heads/{PUBLIC_BRANCH}").decode().strip()

    run(
        "git",
        "fetch",
        "--no-tags",
        PUBLIC_REMOTE,
        "+refs/heads/main:refs/remotes/public-origin/main",
    )
    commits = run("git", "rev-list", "--reverse", "--first-parent", PUBLIC_BRANCH).decode().splitlines()
    remote_tip = run(
        "git", "rev-parse", "--verify", "refs/remotes/public-origin/main"
    ).decode().strip()
    next_index = commits.index(remote_tip) + 1 if remote_tip in commits else 0
    batch_size = PUSH_BATCH_SIZE
    while next_index < len(commits):
        batch = commits[next_index : next_index + batch_size]
        options = ("--force",) if remote_tip not in commits else ()
        try:
            run("git", "push", PUBLIC_REMOTE, f"{batch[-1]}:refs/heads/main", *options)
        except SystemExit:
            # Retry oversized requests with smaller batches. Refresh the remote
            # tip first because a timed-out HTTP response may follow a completed push.
            run(
                "git",
                "fetch",
                "--no-tags",
                PUBLIC_REMOTE,
                "+refs/heads/main:refs/remotes/public-origin/main",
            )
            remote_tip = run(
                "git", "rev-parse", "--verify", "refs/remotes/public-origin/main"
            ).decode().strip()
            if remote_tip in commits:
                next_index = commits.index(remote_tip) + 1
            if batch_size == 1:
                raise
            batch_size = max(1, batch_size // 2)
            continue
        next_index += len(batch)
        remote_tip = batch[-1]

    print(f"Published sanitized {PUBLIC_BRANCH} to {PUBLIC_REMOTE}/main.")
    print(f"Private source commit: {source_commit}")
    print(f"Synchronized public commit: {public_commit}")


if __name__ == "__main__":
    main()
