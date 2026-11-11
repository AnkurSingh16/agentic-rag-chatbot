# Document format

This page describes the documents `ragctl train` reads and how each one gets its access tags. Which sources are read is set in `instance.yaml` ([Instance configuration](instance-config.md#sources)); how tags are matched at query time is in [ADR 0003](../adr/0003-access-modes-and-row-level-security.md).

## Supported documents

| Source           | Accepted                                                                  | Access tags from               |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------ |
| `folder`         | Files ending in `.md`, `.markdown` or `.txt` (any case), read recursively | Front-matter                   |
| `urls`, markdown | `Content-Type: text/markdown` or `text/x-markdown`                        | Front-matter                   |
| `urls`, text     | `Content-Type: text/plain`                                                | Front-matter                   |
| `urls`, HTML     | `Content-Type: text/html` or `application/xhtml+xml`                      | `<meta name="rag-access">` tag |

Folder sources skip hidden files and directories (names starting with `.`) and symbolic links, and must stay inside the instance directory. Other URL content types are rejected. Each document may be at most 2 MiB. URL fetching limits (https only, public addresses only, 3 redirects, 10 seconds) are listed in [Instance configuration](instance-config.md#sources).

## Front-matter

Markdown and text documents can start with a YAML block between two `---` lines. It must be the first thing in the document:

```markdown
---
access: [staff, managers]
---

# Leave policy

Staff accrue four weeks of annual leave per year.
```

| Key      | Value                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `access` | Non-empty list of access tags. Each tag matches `^[a-z0-9][a-z0-9._:-]{0,63}$`. Duplicates are removed and the list is sorted. |
| `tenant` | Not supported yet. A document that sets it is rejected, because every document is stored with tenant `_` for now.              |

Other keys are ignored. An empty block is the same as no block. The block must be a YAML mapping; invalid YAML, a non-mapping block, an empty `access` list or an invalid tag fails training with the document's path.

The block is removed before chunking, so it is never shown in answers. It is included in the document's content hash, so changing only the tags still produces a changed document.

## HTML access tag

HTML pages carry their tags in a meta tag, usually in `<head>`:

```html
<meta name="rag-access" content="staff, managers" />
```

- `content` is a comma-separated list of tags, with the same tag rule as front-matter. Spaces around commas are ignored; an empty entry (`a,,b`) or empty `content` is an error.
- The `name` value and attribute names are case-insensitive, and attributes may be in any order and use single or double quotes.
- Meta tags inside HTML comments are ignored.
- A page with more than one `rag-access` meta tag is rejected, because the two could disagree.
- Front-matter is not read from HTML.

## Titles

| Document      | Title                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Markdown file | First `#` to `######` heading after the front-matter, else the file name |
| Text file     | File name without extension                                              |
| Markdown URL  | First heading, else the URL                                              |
| Text URL      | The URL                                                                  |
| HTML URL      | `<title>`, else the first heading, else the URL                          |

## Defaults per access mode

What happens to a document's tags depends on `auth.mode` in `instance.yaml`:

| Mode            | Document with tags                                                   | Document without tags                                | Who can read a document                                                  |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `public`        | Accepted only if the tags are exactly `[public]`; otherwise rejected | Stored with `[public]`                               | Everyone                                                                 |
| `authenticated` | Stored with its own tags                                             | Stored with `auth.defaultTags`                       | Signed-in callers, who receive `auth.defaultTags`                        |
| `rbac`          | Stored with its own tags                                             | Training fails and lists every document without tags | Callers whose roles grant `docs:read:<tag>` for at least one of its tags |

`rbac` fails closed: there is no default, so a document nobody tagged is never stored where the wrong people could read it. Training validates every document before it writes anything, so a failed run leaves no partial version behind.

In `authenticated` mode every caller holds exactly `auth.defaultTags`, so a document whose tags are all outside that list is stored but readable by no caller. Tags match by overlap: a caller holding any one of a document's tags can read it.
