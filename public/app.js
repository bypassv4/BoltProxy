const form = document.getElementById("url-form");
const input = document.getElementById("url-input");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  let url = input.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  const proxyUrl = "/proxy?url=" + encodeURIComponent(url);
  window.location.href = proxyUrl;
});
