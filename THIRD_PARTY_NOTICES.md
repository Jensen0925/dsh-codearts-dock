# Third-party notices

## dsh-connect-workbuddy (MIT)

Parts of this plugin reproduce layout rules and design decisions from
[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy),
so that the two connector cards read as siblings in the same settings panel.

- **Stylesheet** (`client.js`, the `CSS` constant): the card surface, the
  section tab strip, the account table's grid template and row rhythm, the
  switch rows, the model row's two-line layout, and the type scale are that
  project's rules with this plugin's `dca-` class prefix. The comments carried
  across explain *why* each value is what it is.
- **Structural decisions** mirror it as well: one bulk check-in button rather
  than one per account, account acquisition (add, import, export) in a single
  place, and the platform checkbox themed only with `accent-color` instead of a
  hand-drawn toggle.

## dsh-connect-madao (MIT)

The credential-borrowing path in `src/credentials.js` — reading the CodeArts
client's sign-in out of its `state.vscdb` by anchoring on
`"id":"huawei-cloud-authentication"` and pulling fields from a fixed window past
it, rather than opening SQLite — is adopted from
[dsh-connect-madao](https://github.com/XLNC-L/dsh-connect-madao), MIT, Copyright
(c) 2026 XLNC-L. So are the field spellings (`accessKey`, `secretKey`,
`securityToken`, `expiresAt`, `originData.account.label`), the candidate path
list, and the rule that a token with under five minutes left is treated as
absent rather than used.

The reasoning behind it is that project's too: the file is a SQLite database, but
the credential sits inside it as plain JSON text, and brace-matching from an
arbitrary `{` in binary surroundings walks into unrelated data — hence a known
anchor and a fixed window.

## Original to this project

The protocol implementation, the adapter, the account store, the check-in
guards, and this plugin's Host half are this project's own work.

```
MIT License

Copyright (c) 2026 LaoDing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
