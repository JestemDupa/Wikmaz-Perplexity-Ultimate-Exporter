let isRunning = false;
let linksQueue = [];
let currentIndex = 0;
let mainTabId = null; 
let currentStatusText = "Ready to work";

function updateStatus(text, progress, total) {
    currentStatusText = text;
    try {
        chrome.runtime.sendMessage({ 
            action: "update_status", 
            text: text,
            progress: progress,
            total: total
        }).catch(() => {});
    } catch(e) {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "get_status") {
        sendResponse({
            isRunning: isRunning,
            text: currentStatusText,
            progress: currentIndex,
            total: linksQueue.length
        });
        return true;
    }
    
    if (message.action === "start_batch" && !isRunning) {
        isRunning = true;
        mainTabId = message.tabId; 
        updateStatus("Connecting to Perplexity API...", 0, 0);
        
        chrome.scripting.executeScript({
            target: { tabId: mainTabId },
            func: fetchAllThreadsViaAPI
        }).then((results) => {
            if (!isRunning) return; 
            
            if (results && results[0] && results[0].result && results[0].result.length > 0) {
                linksQueue = results[0].result;
                currentIndex = 0;
                updateStatus("API fetched " + linksQueue.length + " chats. Starting download...", currentIndex, linksQueue.length);
                processNextAPI();
            } else {
                isRunning = false;
                linksQueue = []; 
                updateStatus("No chats found via API.", 0, 0);
                chrome.runtime.sendMessage({ action: "finished" }).catch(()=>{});
            }
        }).catch((err) => {
            isRunning = false;
            linksQueue = []; 
            updateStatus("API Error: " + err.message, 0, 0);
            chrome.runtime.sendMessage({ action: "finished" }).catch(()=>{});
        });
    } else if (message.action === "stop_batch") {
        isRunning = false;
        linksQueue = []; 
        updateStatus("Stopped by user. Memory cleared.", currentIndex, 0);
    }
});

async function fetchAllThreadsViaAPI() {
    let allChats = [];
    let offset = 0;
    const limit = 50; 
    const url = "https://www.perplexity.ai/rest/thread/list_ask_threads?version=2.18&source=default";
    
    while(true) {
        try {
            const response = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: {
                    "accept": "*/*",
                    "content-type": "application/json",
                    "x-perplexity-request-endpoint": url,
                    "x-perplexity-request-try-number": "1"
                },
                body: JSON.stringify({ limit: limit, ascending: false, offset: offset, search_term: "" })
            });
            
            if (!response.ok) break;
            const data = await response.json();
            let list = [];
            
            if (Array.isArray(data)) list = data;
            else if (data && Array.isArray(data.list)) list = data.list;
            else if (data && Array.isArray(data.threads)) list = data.threads;
            
            if (list.length === 0) break; 
            
            list.forEach(item => {
                if (item.uuid) {
                    let spaceName = "General";
                    if (item.collection && item.collection.title) {
                        spaceName = item.collection.title;
                    } else if (item.collection_info && item.collection_info.title) {
                        spaceName = item.collection_info.title;
                    } else if (item.space_info && item.space_info.name) {
                        spaceName = item.space_info.name;
                    }
                    
                    allChats.push({
                        uuid: item.uuid,
                        title: item.title || "Untitled",
                        date: item.inserted_at || item.created_at || new Date().toISOString(),
                        space: spaceName
                    });
                }
            });
            
            chrome.runtime.sendMessage({ action: "update_status", text: "Scanning database... Found: " + allChats.length }).catch(()=>{});
            offset += limit;
            await new Promise(r => setTimeout(r, 400)); 
        } catch (e) {
            break;
        }
    }
    return allChats;
}

function processNextAPI() {
    if (!isRunning) return; 

    if (currentIndex >= linksQueue.length) {
        isRunning = false;
        linksQueue = []; 
        updateStatus("Export completed successfully!", currentIndex, 0);
        chrome.runtime.sendMessage({ action: "finished" }).catch(()=>{});
        return;
    }

    const chatData = linksQueue[currentIndex];
    // ZMIANA: Zamiast "Zrzut" mamy teraz profesjonalne "Exporting"
    updateStatus("Exporting [" + chatData.space + "]: " + (currentIndex + 1) + " of " + linksQueue.length, currentIndex, linksQueue.length);

    const threadUrl = "https://www.perplexity.ai/rest/thread/" + chatData.uuid + "?with_schematized_response=true&version=2.18&source=default";

    chrome.scripting.executeScript({
        target: { tabId: mainTabId },
        func: fetchSingleChatContent,
        args: [chatData, threadUrl]
    }).then((results) => {
        if(!isRunning) return;
        
        if (results && results[0] && results[0].result) {
            const data = results[0].result;
            const blobUrl = "data:text/markdown;charset=utf-8," + encodeURIComponent(data.content);
            
            let safeTitle = chatData.title.replace(/[^a-z0-9A-Z_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, '_').substring(0, 80).trim();
            let safeSpace = chatData.space.replace(/[^a-z0-9A-Z_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ \-]/g, '_').trim();
            if (!safeSpace) safeSpace = "General";
            
            let finalFilename = "Perplexity_Export/" + safeSpace + "/" + safeTitle + " (" + chatData.uuid + ").md";
            
            chrome.downloads.download({
                url: blobUrl,
                filename: finalFilename,
                saveAs: false
            }, () => {
                currentIndex++;
                setTimeout(processNextAPI, 1000); 
            });
        } else {
            currentIndex++;
            setTimeout(processNextAPI, 1000);
        }
    }).catch(() => {
        currentIndex++;
        setTimeout(processNextAPI, 1000);
    });
}

async function fetchSingleChatContent(metadata, apiUrl) {
    try {
        const response = await fetch(apiUrl, {
            method: "GET",
            credentials: "include",
            headers: {
                "accept": "*/*",
                "x-perplexity-request-endpoint": apiUrl,
                "x-perplexity-request-reason": "search-components"
            }
        });
        
        if(!response.ok) return null;
        const data = await response.json();
        
        let markdown = "# " + metadata.title + "\n\n";
        markdown += "**Space:** " + metadata.space + "\n";
        markdown += "**ID:** " + metadata.uuid + "\n";
        markdown += "**Date:** " + metadata.date + "\n\n---\n\n";
        
        if (data && data.entries && Array.isArray(data.entries)) {
            data.entries.forEach(entry => {
                if (entry.query_str) {
                    markdown += "## 👤 User:\n" + entry.query_str + "\n\n";
                    markdown += "## 🤖 Perplexity:\n";
                    
                    let entryTexts = new Set();
                    let filesFound = [];
                    let stepsFound = [];
                    
                    const extractAggressive = (obj, depth = 0) => {
                        if (depth > 20 || typeof obj !== 'object' || obj === null) return;

                        if (obj.filename || obj.name || (obj.code && obj.language)) {
                            let fname = obj.filename || obj.name || "Generated_File";
                            let fcontent = obj.code || obj.content || obj.text || obj.value;
                            let flang = obj.language || "text";
                            
                            if (fcontent && typeof fcontent === 'string' && fcontent.length > 5) {
                                let fileBlock = `> 📦 **Generated File/Artifact:** \`${fname}\`\n\n\`\`\`${flang}\n${fcontent}\n\`\`\`\n`;
                                if (!filesFound.includes(fileBlock)) filesFound.push(fileBlock);
                                obj.code = ""; obj.content = ""; obj.text = ""; obj.value = "";
                            }
                        }

                        if (obj.action || obj.step_type || obj.tool_name || obj.query) {
                            let stepTitle = obj.action || obj.step_type || obj.tool_name || obj.title || "Background Operation";
                            let stepDetail = obj.query || obj.text || obj.summary || "";
                            
                            if (stepDetail && typeof stepDetail === 'string' && stepDetail.length > 2) {
                                let stepStr = `> 👣 **Step:** \`${stepTitle}\`\n> *Details:* ${stepDetail.replace(/\n/g, ' ')}\n`;
                                if (!stepsFound.includes(stepStr)) stepsFound.push(stepStr);
                            }
                        }

                        Object.keys(obj).forEach(key => {
                            let val = obj[key];
                            if (typeof val === 'string' && val.length > 50) {
                                let k = key.toLowerCase();
                                if (!k.includes('id') && !k.includes('url') && !k.includes('date') && !k.includes('time') && !k.includes('query')) {
                                    entryTexts.add(val);
                                }
                            } else if (typeof val === 'object') {
                                extractAggressive(val, depth + 1);
                            }
                        });
                    };
                    
                    extractAggressive(entry);
                    
                    if (stepsFound.length > 0) {
                        markdown += "### 👣 AI Step Log:\n";
                        stepsFound.forEach(s => { markdown += s + "\n"; });
                        markdown += "\n";
                    }

                    let answer = "";
                    if (entry.blocks && Array.isArray(entry.blocks)) {
                        const textBlock = entry.blocks.find(b => b.intended_usage === "ask_text" || b.intended_usage === "answer" || b.markdown_block);
                        if (textBlock && textBlock.markdown_block && textBlock.markdown_block.answer) {
                            answer = textBlock.markdown_block.answer;
                        }
                    }
                    if(answer) markdown += "### 📝 Main Answer:\n" + answer + "\n\n";

                    if (filesFound.length > 0) {
                        markdown += "### 📦 Generated Files & Artifacts:\n";
                        filesFound.forEach(f => { markdown += f + "\n\n"; });
                    }

                    let uniqueTexts = Array.from(entryTexts).sort((a, b) => b.length - a.length);
                    let finalEntryMarkdown = "";
                    
                    uniqueTexts.forEach(t => {
                        let checkStr = t.trim().substring(0, 100); 
                        if (checkStr.length > 10 && !finalEntryMarkdown.includes(checkStr) && !markdown.includes(checkStr)) {
                            finalEntryMarkdown += t + "\n\n";
                        }
                    });
                    
                    if (finalEntryMarkdown.trim().length > 0) {
                        markdown += "### 🗃️ Cache Dump (Additional Data):\n" + finalEntryMarkdown;
                    }
                    
                    markdown += "---\n\n";
                }
            });
        }
        return { content: markdown };
    } catch(e) {
        return null;
    }
}