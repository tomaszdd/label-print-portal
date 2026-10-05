#!/bin/sh
# Logs Brother printer USB connect/disconnect events with timestamps
LOG=/home/pi/label-portal/usb_events.log
udevadm monitor --udev --subsystem-match=usb 2>/dev/null | while read -r line; do
  case "$line" in
    *UDEV*)
      echo "$(date '+%Y-%m-%d %H:%M:%S') $line" >> "$LOG"
      ;;
  esac
done
