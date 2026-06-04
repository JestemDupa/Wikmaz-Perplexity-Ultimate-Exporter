const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progressBar');

// Check the background process status when popup opens
chrome.runtime.sendMessage({ action: "get_status" }, (response) => {
    if (response && response.isRunning) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        progressBar.style.display = 'block';
        statusEl.innerText = response.text || "Resuming preview...";
        if (response.total) {
            progressBar.max = response.total;
            progressBar.value = response.progress;
        }
    }
});

startBtn.addEventListener('click', async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("perplexity.ai")) {
        statusEl.innerText = "Error: Please open Perplexity first!";
        return;
    }

    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    progressBar.style.display = 'block';
    statusEl.innerText = "Initializing API fetch...";

    chrome.runtime.sendMessage({ action: "start_batch", tabId: tab.id });
});

stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "stop_batch" });
    statusEl.innerText = "Stopped by user.";
    stopBtn.style.display = 'none';
    startBtn.style.display = 'block';
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "update_status") {
        statusEl.innerText = message.text;
        if (message.progress !== undefined && message.total !== undefined) {
            progressBar.max = message.total;
            progressBar.value = message.progress;
        }
    } else if (message.action === "finished") {
        stopBtn.style.display = 'none';
        startBtn.style.display = 'block';
        progressBar.style.display = 'none';
    }
});