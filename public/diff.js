// Whitespace and comments are kept for display but skipped in the comparison.
function tokenize(src) {
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|[A-Za-z_]\w*|\d+\w*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|./g;
  const segs = [];
  let m;
  while ((m = re.exec(src))) {
    const text = m[0];
    segs.push({ text, code: !/^\s/.test(text) && !text.startsWith('//') && !text.startsWith('/*') });
  }
  return segs;
}

// Code segments of mine and ref get `match: true` when they are part of the longest common subsequence.
export function diff(mine, ref) {
  const a = tokenize(mine);
  const b = tokenize(ref);
  const ai = a.filter((s) => s.code);
  const bi = b.filter((s) => s.code);
  const n = ai.length;
  const m = bi.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ai[i].text === bi[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ai[i].text === bi[j].text) {
      ai[i].match = bi[j].match = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { mine: a, ref: b, extra: n - dp[0][0], missing: m - dp[0][0] };
}
