/**
 * Mouse for Ink.
 *
 * Ink reads keys, not clicks. A terminal only sends mouse events to an app that
 * asks for them, so we turn on SGR tracking (1006) with button+drag reporting
 * (1002) and parse the escape sequences ourselves off the same raw stdin Ink is
 * already holding in raw mode.
 *
 * Sequence shape: ESC [ < button ; col ; row (M=press, m=release), 1-based.
 * Wheel arrives as button 64 (up) and 65 (down).
 *
 * The modes MUST be turned off on exit, or the terminal keeps swallowing clicks
 * after the process is gone and normal text selection stays broken.
 */
export type MouseEvent = {
  type: "press" | "release" | "wheel";
  button: number;
  col: number;
  row: number;
  direction?: "up" | "down";
};

const ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function enableMouse(onEvent: (e: MouseEvent) => void) {
  process.stdout.write(ON);

  const onData = (buf: Buffer | string) => {
    const s = typeof buf === "string" ? buf : buf.toString("utf8");
    SGR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SGR.exec(s))) {
      const button = Number(m[1]);
      const col = Number(m[2]);
      const row = Number(m[3]);
      if (button >= 64) {
        onEvent({ type: "wheel", button, col, row, direction: button === 64 ? "up" : "down" });
      } else if (m[4] === "M") {
        onEvent({ type: "press", button, col, row });
      } else {
        onEvent({ type: "release", button, col, row });
      }
    }
  };

  process.stdin.on("data", onData);

  const off = () => {
    process.stdin.off("data", onData);
    process.stdout.write(OFF);
  };
  // a crash or a ^C must not leave the terminal in mouse mode
  process.once("exit", off);
  process.once("SIGINT", () => {
    off();
    process.exit(0);
  });
  return off;
}
