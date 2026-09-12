export function initSidebar(el) {
  el.classList.remove('collapsed');
  el.querySelector('.toggle').addEventListener('click', () => {
    el.classList.toggle('collapsed');
  });
}
