(() => {
  const form = document.querySelector(".radar-toolbar");
  if (!form) return;
  const query = document.querySelector("#radar-query");
  const topic = document.querySelector("#radar-topic");
  const status = document.querySelector("#filter-result");
  const groups = [...document.querySelectorAll(".radar-group")];
  const update = () => {
    let hits = 0;
    const needle = query.value.trim().toLocaleLowerCase();
    for (const group of groups) {
      const rows = [...group.querySelectorAll(".radar-list > li")];
      const inTopic = !topic.value || topic.value === group.dataset.topic;
      let listed = 0;
      for (const row of rows) {
        row.hidden = !inTopic || (needle && !row.textContent.toLocaleLowerCase().includes(needle));
        listed += row.hidden ? 0 : 1;
      }
      group.hidden = !inTopic || (Boolean(needle) && !listed);
      hits += listed;
    }
    status.textContent = hits ? `${hits} 条可见` : "没有匹配条目";
  };
  form.hidden = false;
  form.addEventListener("submit", (evt) => { evt.preventDefault(); update(); });
  form.addEventListener("input", update);
  form.addEventListener("reset", () => window.requestAnimationFrame(update));
  update();
})();
