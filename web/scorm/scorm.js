/* SCORM 1.2: tell the LMS the tool was opened, so it shows as completed.
 * Only in the SCORM package (npm run scorm). The LMS's API object lives in a
 * parent or opener window; these are JavaScript calls between windows, not
 * network requests, so the page's connect-src 'none' still holds. Outside an
 * LMS no API is found and nothing happens. */
(function () {
  function findApi(win) {
    for (var hops = 0; win && hops < 10; hops++) {
      try {
        if (win.API) return win.API;
        if (win.parent === win) break;
        win = win.parent;
      } catch (e) {
        break; // A window from another site: stop looking.
      }
    }
    return null;
  }

  var api = findApi(window) || (window.opener ? findApi(window.opener) : null);
  if (!api) return;

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    api.LMSCommit("");
    api.LMSFinish("");
  }

  if (String(api.LMSInitialize("")) !== "true") return;
  api.LMSSetValue("cmi.core.lesson_status", "completed");
  api.LMSCommit("");
  window.addEventListener("pagehide", finish);
  window.addEventListener("beforeunload", finish);
})();
