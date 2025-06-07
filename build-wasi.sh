#!/bin/sh
GOOS=wasip1 GOARCH=wasm go build -o eget.wasm -ldflags="-s -w" -trimpath
