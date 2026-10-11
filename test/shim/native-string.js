'use strict';
module.exports = {
  entityDecode: s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
  paramEscape: encodeURIComponent,
  pathEscape: encodeURI,
  durationToString: s => String(s),
  isUtf8: () => true,
  utf8FromBytes: b => String(b)
};
