import { validateLogs } from "./validator.js";
import { exportAllLogs } from "./storage.js";

/* -------------------------
   TOGGLE
------------------------- */

chrome.storage.local.get(["logging_enabled"], (res) => {
  const enabled = res.logging_enabled ?? false;
  document.getElementById("toggleLogging").checked = enabled;
});

document.getElementById("toggleLogging")
  .addEventListener("change", (e) => {
    chrome.storage.local.set({
      logging_enabled: e.target.checked
    });
});

/* =========================
   EXPORT LOGS
========================= */
document.getElementById("export").addEventListener("click", async () => {
  const logs = await exportAllLogs();

  if (!logs || logs.trim() === "") {
    alert("No logs to export.");
    return;
  }

  const blob = new Blob([logs], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: "user_logs.jsonl",
    saveAs: false
  });
});

// document.getElementById("export")
//   .addEventListener("click", () => {

//     chrome.storage.local.get(null, (res) => {

//       const segments = Object.keys(res)
//         .filter(k => k.startsWith("user_logs_segment_"))
//         .sort((a, b) => {
//           const na = parseInt(a.split("_").pop());
//           const nb = parseInt(b.split("_").pop());
//           return na - nb;
//         });

//       let combined = "";

//       segments.forEach(seg => {
//         combined += res[seg];
//       });

//       if (!combined || combined.trim() === "") {
//         alert("No logs to export.");
//         return;
//       }

//       const blob = new Blob([combined], {
//         type: "application/json"
//       });

//       const url = URL.createObjectURL(blob);

//       chrome.downloads.download({
//         url,
//         filename: "user_logs.jsonl",
//         saveAs: false
//       });
//     });
// });

/* =========================
   CLEAR LOGS
========================= */
document.getElementById("clear").addEventListener("click", () => {
  const ok = confirm(
    "This will permanently delete all stored logs.\n\nThis action cannot be undone."
  );

  if (!ok) return;

  chrome.storage.local.clear(() => {
    alert("Logs cleared successfully.");
  });
});

/* =========================
   VALIDATE LOGS
========================= */
document.getElementById("validate").addEventListener("click", async() => {
  const logs = await exportAllLogs();

  if (!logs || logs.trim() === "") {
    alert("No logs found to validate.");
    return;
  }

  // chrome.storage.local.get("user_logs", (res) => {
  //   if (!res.user_logs || res.user_logs.trim() === "") {
  //     alert("No logs found to validate.");
  //     return;
  //   }

    let errors;
    try {
      errors = validateLogs(logs);
    } catch (e) {
      alert("Validator crashed:\n" + e.message);
      return;
    }

    if (errors.length === 0) {
      alert("✅ Logs are valid.\n\nNo schema, session, or sequence errors found.");
    } else {
      alert(
        "❌ Validation failed.\n\n" +
        `Errors found: ${errors.length}\n\n` +
        errors.join("\n")
      );
    }
  });

// Load toggle state
// chrome.storage.local.get(["logging_enabled"], (res) => {
//   const enabled = res.logging_enabled ?? false;
//   document.getElementById("toggleLogging").checked = enabled;
// });
chrome.storage.local.get(["logging_enabled"], (res) => {
  document.getElementById("toggleLogging").checked =
    res.logging_enabled ?? false;
});

