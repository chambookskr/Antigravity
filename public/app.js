const elements = {
  form: document.querySelector("#extract-form"),
  id: document.querySelector("#id-input"),
  pw: document.querySelector("#pw-input"),
  year: document.querySelector("#year-input"),
  loginButton: document.querySelector("#login-button"),
  clearButton: document.querySelector("#clear-button"),
  copyButton: document.querySelector("#copy-button"),
  csvLink: document.querySelector("#csv-link"),
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  resultBody: document.querySelector("#result-body"),
};

let rows = [];

function checkedMonths() {
  return [...document.querySelectorAll('input[name="month"]:checked')].map((input) => Number(input.value));
}

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function setBusy(isBusy) {
  elements.form.querySelectorAll("button, input").forEach((item) => {
    item.disabled = isBusy;
  });
}

function setCsvLink(url) {
  if (!url) {
    elements.csvLink.href = "#";
    elements.csvLink.classList.add("disabled");
    elements.csvLink.setAttribute("aria-disabled", "true");
    return;
  }

  elements.csvLink.href = url;
  elements.csvLink.classList.remove("disabled");
  elements.csvLink.setAttribute("aria-disabled", "false");
}

function clearTable() {
  while (elements.resultBody.firstChild) {
    elements.resultBody.removeChild(elements.resultBody.firstChild);
  }
}

function render(nextRows, errors = [], csvUrl = "") {
  rows = nextRows;
  clearTable();
  elements.copyButton.disabled = rows.length === 0;
  setCsvLink(csvUrl);

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    tr.className = "empty-row";
    td.colSpan = 2;
    td.textContent = "아직 추출된 결과가 없습니다.";
    tr.append(td);
    elements.resultBody.append(tr);
    elements.summary.textContent = errors.length ? errors.join(" ") : "결과 없음";
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const impressions = document.createElement("td");
    const keywords = document.createElement("td");
    impressions.textContent = String(row.impressions);
    keywords.textContent = row.keywords;
    tr.append(impressions, keywords);
    elements.resultBody.append(tr);
  });

  const top = rows[0]?.impressions || 0;
  const extra = errors.length ? ` 일부 항목: ${errors.join(" ")}` : "";
  elements.summary.textContent = `${rows.length.toLocaleString("ko-KR")}개 노출수 구간을 ${top}부터 1까지 높은 순으로 정리했습니다.${extra}`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(shortError(data.error || "처리 중 문제가 생겼습니다."));
  return data;
}

function shortError(message) {
  const text = String(message || "");
  if (/launchPersistentContext|Browser logs|remote-debugging-pipe|user-data-dir|Target page/i.test(text)) {
    return "Chrome 자동화 창을 여는 중 문제가 생겼습니다. 이미 열린 자동화 Chrome 창을 닫고 앱을 다시 실행해 주세요.";
  }
  return text.length > 420 ? `${text.slice(0, 420)}...` : text;
}

async function openLogin() {
  const url = "";
  const id = elements.id.value.trim();
  const pw = elements.pw.value.trim();

  setBusy(true);
  setStatus("Chrome을 여는 중입니다...");
  try {
    const data = await postJson("/api/open-login", { url, id, pw });
    setStatus(data.message, "ok");
  } catch (error) {
    setStatus(error.message, "warn");
  } finally {
    setBusy(false);
  }
}

async function extract(event) {
  event.preventDefault();

  const url = "";
  const id = elements.id.value.trim();
  const pw = elements.pw.value.trim();
  const months = checkedMonths();

  if (!months.length) {
    setStatus("추출할 월을 하나 이상 체크해 주세요.", "warn");
    return;
  }

  setBusy(true);
  render([]);
  setStatus("선택한 월과 광고 그룹의 노출 키워드를 읽는 중입니다...");

  try {
    const data = await postJson("/api/extract", {
      url,
      id,
      pw,
      year: Number(elements.year.value),
      months,
    });
    render(data.rows || [], data.errors || [], data.csvUrl || "");
    setStatus(data.message, data.rows?.length ? "ok" : "warn");
  } catch (error) {
    setStatus(error.message, "warn");
  } finally {
    setBusy(false);
  }
}

function copyRows() {
  if (!rows.length) return;
  const text = ["노출수\t키워드"].concat(rows.map((row) => `${row.impressions}\t${row.keywords}`)).join("\n");
  navigator.clipboard.writeText(text);
  setStatus("엑셀에 붙여넣을 수 있게 복사했습니다.", "ok");
}

function clear() {
  render([]);
  setStatus("초기화했습니다.");
}

elements.form.addEventListener("submit", extract);
elements.loginButton.addEventListener("click", openLogin);
elements.copyButton.addEventListener("click", copyRows);
elements.clearButton.addEventListener("click", clear);

elements.csvLink.addEventListener("click", (event) => {
  if (elements.csvLink.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});
