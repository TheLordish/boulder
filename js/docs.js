/* docs.js — reading a body composition report out of a file.

   A photo of a printout already works. This takes the file itself, which is
   what a gym actually emails you, and is both sharper and less fiddly.

     PDF   rendered to an image with pdf.js, then read visually. These reports
           are laid out in boxes and diagrams, so the picture carries meaning
           the extracted text loses.
     DOCX  unzipped in the browser and the document text pulled out.
     TXT   used as is.
     image handed to the existing photo path.

   pdf.js is fetched only when a PDF actually arrives, so it costs nothing on
   any other launch and the app still works with no connection. */
(function (App) {
  "use strict";

  var PDFJS_VER = "4.10.38";
  var PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VER + "/pdf.min.mjs";
  var PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VER + "/pdf.worker.min.mjs";

  var docs = {
    kind: function (file) {
      var n = (file.name || "").toLowerCase();
      var t = file.type || "";
      if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
      if (n.endsWith(".docx") || t.indexOf("wordprocessingml") > -1) return "docx";
      if (t.indexOf("image/") === 0) return "image";
      if (t.indexOf("text/") === 0 || n.endsWith(".txt")) return "text";
      return "unknown";
    },

    /* ---- PDF ---- */
    _pdfjs: null,
    loadPdfjs: async function () {
      if (this._pdfjs) return this._pdfjs;
      var mod = await import(/* webpackIgnore: true */ PDFJS);
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      this._pdfjs = mod;
      return mod;
    },

    /* Render up to `max` pages as JPEGs. Composition reports put the numbers on
       page one or two, so there is no point sending six. */
    pdfPages: async function (file, max) {
      var pdfjs = await this.loadPdfjs();
      var buf = await file.arrayBuffer();
      var doc = await pdfjs.getDocument({ data: buf }).promise;
      var out = [];
      var n = Math.min(doc.numPages, max || 2);
      for (var i = 1; i <= n; i++) {
        var page = await doc.getPage(i);
        // 1.6 is enough for small print without producing a huge image
        var vp = page.getViewport({ scale: 1.6 });
        var c = document.createElement("canvas");
        c.width = Math.min(1500, Math.round(vp.width));
        c.height = Math.round(vp.height * (c.width / vp.width));
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({
          canvasContext: ctx,
          viewport: page.getViewport({ scale: 1.6 * (c.width / vp.width) })
        }).promise;
        out.push(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
      }
      return out;
    },

    /* ---- DOCX ----
       A .docx is a zip. Rather than pull in a library, read the central
       directory, inflate word/document.xml, and strip the tags. */
    docxText: async function (file) {
      var buf = new Uint8Array(await file.arrayBuffer());
      var dv = new DataView(buf.buffer);
      // find the end-of-central-directory record
      var eocd = -1;
      for (var i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error("not a readable docx");
      var count = dv.getUint16(eocd + 10, true);
      var off = dv.getUint32(eocd + 16, true);
      var target = null;
      for (var n = 0; n < count; n++) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        var nameLen = dv.getUint16(off + 28, true);
        var extraLen = dv.getUint16(off + 30, true);
        var cmtLen = dv.getUint16(off + 32, true);
        var local = dv.getUint32(off + 42, true);
        var name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
        if (name === "word/document.xml") { target = { local: local }; }
        off += 46 + nameLen + extraLen + cmtLen;
      }
      if (!target) throw new Error("no document inside that file");

      var lo = target.local;
      if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error("damaged docx");
      var method = dv.getUint16(lo + 8, true);
      var compSize = dv.getUint32(lo + 18, true);
      var nLen = dv.getUint16(lo + 26, true);
      var xLen = dv.getUint16(lo + 28, true);
      var start = lo + 30 + nLen + xLen;
      var raw = buf.subarray(start, start + compSize);

      var xml;
      if (method === 0) {
        xml = new TextDecoder().decode(raw);
      } else {
        // deflate, which the browser can inflate natively
        var ds = new DecompressionStream("deflate-raw");
        var blob = new Blob([raw]).stream().pipeThrough(ds);
        xml = await new Response(blob).text();
      }
      return xml
        .replace(/<w:p[ >]/g, "\n<w:p ")
        .replace(/<w:tab[^>]*>/g, "\t")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    },

    /* Returns message content ready for the model, whatever went in. */
    toContent: async function (file, rules) {
      var k = this.kind(file);
      if (k === "pdf") {
        var pages = await this.pdfPages(file, 2);
        if (!pages.length) throw new Error("that PDF has no pages");
        var parts = pages.map(function (p) {
          return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p } };
        });
        parts.push({ type: "text", text: rules });
        return parts;
      }
      if (k === "image") {
        var b64 = await new Promise(function (res, rej) {
          var r = new FileReader();
          r.onload = function () { res(String(r.result).split(",")[1]); };
          r.onerror = function () { rej(new Error("could not read that image")); };
          r.readAsDataURL(file);
        });
        return [
          { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: b64 } },
          { type: "text", text: rules }
        ];
      }
      if (k === "docx" || k === "text") {
        var text = k === "docx" ? await this.docxText(file) : await file.text();
        if (!text || text.length < 20) throw new Error("that file had no readable text");
        return rules + "\n\nThe report:\n" + text.slice(0, 12000);
      }
      throw new Error("unsupported file, use a PDF, a Word document or a photo");
    }
  };

  App.docs = docs;
})(window.App = window.App || {});
