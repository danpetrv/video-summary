# src/ must run on plain Node: no Bun globals and no bun / bun:* modules
# (from "bun", import("bun:x"), require('bun'), side-effect import "bun:x"; either quote).
pat='\bBun\.|(\bfrom|\bimport|\brequire)[[:space:]]*\(?[[:space:]]*["'"'"']bun(:[^"'"'"']*)?["'"'"']'
grep -rnE "$pat" src && { echo "Bun API in src/"; exit 1; } || exit 0
