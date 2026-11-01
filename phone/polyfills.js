// The phone page also runs in the older built-in browsers of e-readers, which lack these.
if (!Map.groupBy) {
  Map.groupBy = (items, key) => {
    const groups = new Map();
    let i = 0;
    for (const item of items) {
      const k = key(item, i++);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    }
    return groups;
  };
}

for (const type of [Array, String]) {
  if (!type.prototype.at) {
    Object.defineProperty(type.prototype, 'at', {
      configurable: true,
      writable: true,
      value(n) {
        const i = Math.trunc(n) || 0;
        return this[i < 0 ? this.length + i : i];
      },
    });
  }
}
