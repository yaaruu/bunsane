/**
 * Pinned swagger-ui-dist@5.10.3. Integrity is sha384 of the bytes served by
 * unpkg for that version. The init script is same-origin so it needs no SRI.
 */
const SWAGGER_CSS = "https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui.css";
const SWAGGER_CSS_SRI = "sha384-h0W3Vqg5Snxbn56nHu/JCHYsKdSuoEcQneezEWEYGsAdajQJkgD+v9Qy8cuv/1bA";
const SWAGGER_JS = "https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui-bundle.js";
const SWAGGER_JS_SRI = "sha384-jVJWQ0wtFEKcwLYTTe3ZTkA8DbVK3s5bLmxjc30v16evmnx8m4NYVsc52bA+qIUl";

export const SWAGGER_INIT_JS = `window.onload = function () {
    window.SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [
            window.SwaggerUIBundle.presets.apis,
            window.SwaggerUIBundle.presets.standalone
        ],
        plugins: [
            window.SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "BaseLayout"
    });
};
`;

const htmlCache = new Map<string, string>();

export function docsHtml(title: string): string {
    const cached = htmlCache.get(title);
    if (cached) return cached;
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>${escapeHtml(title)} Documentation</title>
    <link rel="stylesheet" href="${SWAGGER_CSS}" integrity="${SWAGGER_CSS_SRI}" crossorigin="anonymous" />
    <style>
        html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
        *, *:before, *:after { box-sizing: inherit; }
        body { margin: 0; background: #fafafa; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_JS}" integrity="${SWAGGER_JS_SRI}" crossorigin="anonymous"></script>
    <script src="/docs/swagger-init.js"></script>
</body>
</html>`;
    htmlCache.set(title, html);
    return html;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
