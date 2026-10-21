#!/usr/bin/env python3
import sys
from pathlib import Path

path = Path(sys.argv[1])
minimum = float(sys.argv[2])
branches_found = branches_hit = 0
in_contract_source = False
for line in path.read_text(encoding="utf-8").splitlines():
    if line.startswith("SF:"):
        in_contract_source = line[3:].replace("\\", "/").startswith("src/")
    elif line == "end_of_record":
        in_contract_source = False
    elif in_contract_source and line.startswith("BRF:"):
        branches_found += int(line[4:])
    elif in_contract_source and line.startswith("BRH:"):
        branches_hit += int(line[4:])

coverage = 100.0 if branches_found == 0 else branches_hit * 100.0 / branches_found
print(f"Branch coverage: {branches_hit}/{branches_found} ({coverage:.2f}%), required {minimum:.2f}%")
if branches_found == 0 or coverage < minimum:
    raise SystemExit(1)
