/**
 * ⌘K on a wide screen: focus the visible header search field (HeaderSearch).
 * False when none is showing, so the caller opens the search sheet instead.
 * Its own module so a header that lazy-loads the field does not import it.
 */
export function focusHeaderSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>('input[data-header-search]')
  if (!el || el.offsetParent === null) return false
  el.focus()
  return true
}
