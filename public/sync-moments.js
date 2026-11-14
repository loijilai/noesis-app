const isPractice = (url) => new URL(url).hash.includes('/practice');

// Moving between cards and rounds stays within practice; any other move leaves the page, so what was done there goes out.
export function leavesPage(oldURL, newURL) {
  return !(isPractice(oldURL) && isPractice(newURL));
}
