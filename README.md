# ImgtoHTML — screenshot report to Canvas HTML

ImgtoHTML turns screenshots from IT courses (terminals, code, app windows,
diagrams) into accessible, responsive HTML for Canvas pages.

An AI chat (ChatGPT or Claude) reads the screenshot and writes a **report**:
the exact text, the window's parts and its colors. ImgtoHTML turns the report
into Canvas HTML, entirely in the browser:

- no tables, inline styles only, nothing Canvas strips;
- code and long lines wrap on phones instead of being cut off;
- terminals and code in the course's VS Code Dark+ theme, with syntax colors;
- every text color at 4.5:1 contrast or better;
- a labelled figure for screen readers, window decorations hidden from them.

The page uploads nothing: it has no server, and its security policy forbids
it from sending data anywhere. Screenshots go only to the AI chat you choose,
so crop or blur names, emails and passwords before sending one.

## Use it

1. **Get a report.** Press **Copy AI instructions** and paste them into
   ChatGPT or Claude once. Then send the chat your screenshot. It replies with
   the report.
2. **Paste the report** into ImgtoHTML. Problems with it are listed right away,
   ready to send back to the AI.
3. **Check** what the AI marked as unsure or cut off, against your screenshot.
4. **Copy the HTML** and paste it into Canvas with the `</>` HTML editor.

Diagrams become a written description: upload the screenshot to Canvas too
and put the description with it.

## Host it

The `Publish to GitHub Pages` workflow builds the page and publishes it at
`https://<owner>.github.io/<repository>/` on every push to `main`, after the
tests pass. Turn it on once in the repository's **Settings → Pages → Source:
GitHub Actions**. To put the tool inside Canvas, embed that address in a
Canvas page with an iframe.

## Develop

    cd web
    npm ci
    npm run dev        # http://127.0.0.1:5173
    npm test           # unit tests and a browser test of the page
    npm run build      # the static site, in web/dist

See [web/README.md](web/README.md) for the report format and how the code fits
together.
