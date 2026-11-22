const markupCache = new WeakMap<Element, string>();

export function setText(element: Element | null, value: string) {
  if (element && element.textContent !== value) element.textContent = value;
}

export function setMarkup(element: Element, value: string) {
  if (markupCache.get(element) !== value) {
    element.innerHTML = value;
    markupCache.set(element, value);
  }
}
