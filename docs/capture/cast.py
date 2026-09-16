# frames of `tmux capture-pane -e` -> asciicast v2, one event per changed frame; a frame whose text
# matches HOLD is held for HOLD_S seconds so a short moment reads in the gif
import json, sys, glob, os
out, width, height, fps = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
src = sys.argv[5]
files = sorted(glob.glob(src + '/*.txt')) if os.path.isdir(src) else [src]
lo, hi = (int(sys.argv[6]), int(sys.argv[7])) if len(sys.argv) > 7 else (0, len(files))
hold, hold_s = (sys.argv[8], float(sys.argv[9])) if len(sys.argv) > 9 else (None, 0)
with open(out, 'w') as o:
    o.write(json.dumps({"version": 2, "width": width, "height": height, "env": {"TERM": "xterm-256color"}}) + '\n')
    last, t, extra = None, 0.0, 0.0
    for i, f in enumerate(files[lo:hi]):
        text = open(f, encoding='utf-8', errors='replace').read()
        lines = (text.split('\n') + [''] * height)[:height]
        body = '\x1b[H\x1b[2J' + '\r\n'.join(l + '\x1b[0m' for l in lines)
        if body == last: continue
        if hold and hold in text and (last is None or hold not in last_text): extra += hold_s
        last, last_text = body, text
        o.write(json.dumps([round(i / fps + extra, 3), "o", body]) + '\n')
    o.write(json.dumps([round(len(files[lo:hi]) / fps + extra + 1.5, 3), "o", ""]) + '\n')
