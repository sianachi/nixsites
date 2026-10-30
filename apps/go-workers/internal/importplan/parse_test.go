package importplan

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"github.com/sianachi/Nix/apps/go-workers/internal/render"
	"hash/crc32"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestTextImportNormalizesUtf8AndRetainsTxtOriginal(t *testing.T) {
	source := fixtureSource(t, "notes.txt", "txt", append([]byte{0xef, 0xbb, 0xbf}, []byte("one\r\ntwo\rthree")...))

	plan, err := Parse(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	if plan.Format != "txt" || len(plan.Items) != 2 || plan.Items[0].Body == nil || plan.Items[0].Body.Text != "one\ntwo\nthree" {
		t.Fatalf("plan = %#v", plan)
	}
	if plan.Items[1].File == nil || plan.Items[1].File.SourceKind != "source" || plan.Items[1].File.SHA256 != source.SHA256 {
		t.Fatalf("original = %#v", plan.Items[1])
	}
}

func TestMarkdownImportDoesNotCreateAnOriginalFileItem(t *testing.T) {
	source := fixtureSource(t, "notes.md", "markdown", []byte("# Heading\n"))

	plan, err := Parse(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 1 || plan.Items[0].Body == nil || plan.Items[0].Body.Encoding != "markdown" {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestTextImportRejectsBinaryAndInvalidUtf8(t *testing.T) {
	for _, body := range [][]byte{{'a', 0, 'b'}, {'a', 0x1b, 'b'}, {'a', 0x7f, 'b'}, {0xff, 0xfe}} {
		source := fixtureSource(t, "bad.txt", "txt", body)
		if _, err := Parse(context.Background(), source, testLimits()); err == nil {
			t.Fatal("expected malformed text to be rejected")
		}
	}
}

func TestDOCXImportPreservesRichBlocksAndExtractsImages(t *testing.T) {
	png := docxPNG(640, 480)
	document := `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="w" xmlns:r="r" xmlns:a="a"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Roadmap</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:hyperlink r:id="link"><w:r><w:t>Read</w:t></w:r></w:hyperlink></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:p><w:r><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p>
</w:body></w:document>`
	rels := `<Relationships><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/docs" TargetMode="External"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/picture.png"/></Relationships>`
	numbering := `<w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>`
	source := zipSource(t, "document.docx", "docx", []zipFixture{
		{"word/document.xml", []byte(document)},
		{"word/_rels/document.xml.rels", []byte(rels)},
		{"word/numbering.xml", []byte(numbering)},
		{"word/styles.xml", []byte(`<w:styles xmlns:w="w"/>`)},
		{"word/header1.xml", []byte(`<w:hdr xmlns:w="w"/>`)},
		{"word/media/picture.png", png},
	})

	plan, err := Parse(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 3 || plan.Items[2].File == nil || !plan.Items[2].File.Previewable || plan.Items[2].File.AssetPath == nil {
		t.Fatalf("items = %#v", plan.Items)
	}
	if plan.Items[0].Body.Encoding != "nix-render" {
		t.Fatalf("encoding = %q", plan.Items[0].Body.Encoding)
	}
	if _, err := render.Decode(plan.Items[0].Body.Render); err != nil {
		t.Fatal(err)
	}
	encoded := string(plan.Items[0].Body.Render)
	for _, expected := range []string{`"kind":"heading"`, `"ordered":true`, `"kind":"table"`, `"src":"nix-file:asset-0001"`, `"href":"https://example.test/docs"`} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("document %s does not contain %s", encoded, expected)
		}
	}
	if len(plan.Loss) == 0 || len(plan.Omissions) == 0 {
		t.Fatalf("reports = loss %#v, omissions %#v", plan.Loss, plan.Omissions)
	}
}

func TestDOCXRejectsEntitiesAndCompressionBombs(t *testing.T) {
	entity := zipSource(t, "entity.docx", "docx", []zipFixture{{"word/document.xml", []byte(`<!DOCTYPE x [<!ENTITY e "bad">]><document/>`)}})
	if _, err := Parse(context.Background(), entity, testLimits()); err == nil {
		t.Fatal("expected entity declaration to be rejected")
	}

	bomb := zipSource(t, "bomb.docx", "docx", []zipFixture{{"word/document.xml", []byte(strings.Repeat("a", 128*1024))}})
	if _, err := Parse(context.Background(), bomb, testLimits()); err == nil || !strings.Contains(err.Error(), "compression ratio") {
		t.Fatalf("error = %v", err)
	}

	deepXML := strings.Repeat("<w:x>", 40) + strings.Repeat("</w:x>", 40)
	deep := zipSource(t, "deep.docx", "docx", []zipFixture{{"word/document.xml", []byte(deepXML)}})
	if _, err := Parse(context.Background(), deep, testLimits()); err == nil || !strings.Contains(err.Error(), "structure") {
		t.Fatalf("deep XML error = %v", err)
	}
}

func TestNixImportPreservesTreeEnvelopesAndBodies(t *testing.T) {
	root := "11111111-1111-4111-8111-111111111111"
	child := "22222222-2222-4222-8222-222222222222"
	workspace := "33333333-3333-4333-8333-333333333333"
	definitions := []any{map[string]any{
		"key": "area", "label": "Area", "type": "select", "options": []string{"Core", "Workers"}, "required": false,
	}}
	views := map[string]any{"default": "catalog", "views": []any{
		map[string]any{"id": "catalog", "name": "Catalog", "kind": "list", "columns": []string{"title", "area"}, "sortBy": "title"},
		map[string]any{"id": "areas", "name": "By area", "kind": "board", "groupBy": "area", "groupOrder": []string{"Core", "Workers"}},
	}}
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 1, "schemaVersion": 3,
		"exportedAt": "2026-09-01T12:00:00Z", "root": root, "rootEffectiveSchema": map[string]any{
			"properties": definitions, "declared": definitions, "inherit": true,
		}, "includesDeleted": true,
		"items": []any{
			map[string]any{"id": root, "parentId": nil, "seq": "1024", "title": "Root", "type": "note"},
			map[string]any{"id": child, "parentId": root, "seq": "2048", "title": "Child", "type": "note"},
		},
		"omitted": []any{map[string]any{"id": nil, "parentId": root, "reason": "limit-reached", "detail": "One child was omitted."}},
		"loss":    []any{},
	}
	bundle := func(id string, parent *string, title string, state string) map[string]any {
		return map[string]any{
			"id": id, "parentId": parent, "workspaceId": workspace, "type": "note", "title": title,
			"seq": map[bool]string{true: "1024", false: "2048"}[parent == nil], "lifecycleState": state,
			"createdAt": "2026-09-01T12:00:00Z", "updatedAt": "2026-09-01T12:00:00Z",
			"properties": map[string]any{"title": title}, "schema": nil, "views": nil,
			"viewRows": []any{}, "viewRowsTruncated": false,
			"body": map[string]any{"schemaVersion": 3, "prosemirror": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph"}}}},
		}
	}
	manifestBytes, _ := json.Marshal(manifest)
	rootBundle := bundle(root, nil, "Root", "active")
	rootBundle["views"] = views
	childBundle := bundle(child, &root, "Child", "deleted")
	childProperties := map[string]any{"title": "Child", "area": "Core", "source_path": "backend/src/Nix.Api/Program.cs"}
	childBundle["properties"] = childProperties
	rootBytes, _ := json.Marshal(rootBundle)
	childBytes, _ := json.Marshal(childBundle)
	source := zipSource(t, "workspace.nix", "nix", []zipFixture{
		{"manifest.json", manifestBytes},
		{"items/" + root + ".json", rootBytes},
		{"items/" + child + ".json", childBytes},
	})

	plan, err := Parse(context.Background(), source, testLimits())

	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 2 || plan.Items[1].ParentSourceID == nil || *plan.Items[1].ParentSourceID != root || plan.Items[1].FinalLifecycleState != "deleted" {
		t.Fatalf("items = %#v", plan.Items)
	}
	if plan.Items[0].Body == nil || plan.Items[0].Body.Encoding != "archive" || len(plan.Omissions) != 1 {
		t.Fatalf("plan = %#v", plan)
	}
	if !strings.Contains(string(plan.Items[0].Schema), `"inherit":false`) {
		t.Fatalf("root schema = %s", plan.Items[0].Schema)
	}
	var importedSchema struct {
		Properties []struct {
			Key     string   `json:"key"`
			Type    string   `json:"type"`
			Options []string `json:"options"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(plan.Items[0].Schema, &importedSchema); err != nil || len(importedSchema.Properties) != 1 ||
		importedSchema.Properties[0].Key != "area" || importedSchema.Properties[0].Type != "select" ||
		len(importedSchema.Properties[0].Options) != 2 || importedSchema.Properties[0].Options[0] != "Core" || importedSchema.Properties[0].Options[1] != "Workers" {
		t.Fatalf("root effective schema was not redeclared: %s", plan.Items[0].Schema)
	}
	expectedViews, _ := json.Marshal(views)
	expectedProperties, _ := json.Marshal(childProperties)
	if string(plan.Items[0].Views) != string(expectedViews) || string(plan.Items[1].Properties) != string(expectedProperties) {
		t.Fatalf("authored views or child properties changed: views=%s properties=%s", plan.Items[0].Views, plan.Items[1].Properties)
	}
}

func TestNixManifestAcceptsCurrentSchemaAndRejectsUnsupportedVersions(t *testing.T) {
	manifest := nixManifest{
		Format: nixArchiveFormat, FormatVersion: nixArchiveVersion, SchemaVersion: nixSchemaMaximum,
		ExportedAt: "2026-09-01T12:00:00Z", Root: "11111111-1111-4111-8111-111111111111",
		Items:   []nixManifestItem{{ID: "11111111-1111-4111-8111-111111111111", Sequence: "1", Title: "Root", Type: "note"}},
		Omitted: []nixOmission{}, Loss: []nixLoss{},
	}
	if err := validateNixManifest(manifest, testLimits()); err != nil {
		t.Fatalf("current schema version was rejected: %v", err)
	}

	for _, version := range []int{0, nixSchemaMaximum + 1} {
		t.Run("version-"+strconv.Itoa(version), func(t *testing.T) {
			manifest.SchemaVersion = version
			if err := validateNixManifest(manifest, testLimits()); err == nil || !strings.Contains(err.Error(), "editor schema") {
				t.Fatalf("schema version %d error = %v", version, err)
			}
		})
	}
}

func TestNixImportRejectsAChildBeforeItsParent(t *testing.T) {
	root := "11111111-1111-4111-8111-111111111111"
	child := "22222222-2222-4222-8222-222222222222"
	manifest := map[string]any{
		"format": "nix-archive", "formatVersion": 1, "schemaVersion": 2,
		"exportedAt": "2026-09-01T12:00:00Z", "root": root, "rootEffectiveSchema": nil,
		"includesDeleted": false, "omitted": []any{}, "loss": []any{},
		"items": []any{
			map[string]any{"id": child, "parentId": root, "seq": "1", "title": "Child", "type": "note"},
			map[string]any{"id": root, "parentId": nil, "seq": "1", "title": "Root", "type": "note"},
		},
	}
	manifestBytes, _ := json.Marshal(manifest)
	emptyBundle := func(id string, parent *string, title string) []byte {
		body, _ := json.Marshal(map[string]any{
			"id": id, "parentId": parent, "workspaceId": "33333333-3333-4333-8333-333333333333",
			"type": "note", "title": title, "seq": "1", "lifecycleState": "active",
			"createdAt": "x", "updatedAt": "x", "properties": map[string]any{}, "schema": nil,
			"views": nil, "viewRows": []any{}, "viewRowsTruncated": false, "body": nil,
		})
		return body
	}
	source := zipSource(t, "bad.nix", "nix", []zipFixture{
		{"manifest.json", manifestBytes},
		{"items/" + child + ".json", emptyBundle(child, &root, "Child")},
		{"items/" + root + ".json", emptyBundle(root, nil, "Root")},
	})
	if _, err := Parse(context.Background(), source, testLimits()); err == nil {
		t.Fatal("expected invalid tree to be rejected")
	}
}

func TestPlanEncodingIsDeterministicAndChecksumProtected(t *testing.T) {
	plan := Plan{Version: Version, Format: "txt", Title: "A", SourceSHA256: strings.Repeat("a", 64), Items: []Item{noteItem("root", nil, 0, "A", &Body{Encoding: "plain_text", Text: "hello"})}, Loss: []string{}, Omissions: []string{}}
	first, digest, err := Encode(plan, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	second, secondDigest, err := Encode(plan, 1<<20)
	if err != nil || string(first) != string(second) || digest != secondDigest {
		t.Fatalf("determinism failed: %v", err)
	}
	if _, err := Decode(first, strings.Repeat("0", 64), testLimits()); err == nil {
		t.Fatal("expected checksum mismatch")
	}
	if _, err := Decode(first, digest, testLimits()); err != nil {
		t.Fatal(err)
	}
}

type zipFixture struct {
	name string
	body []byte
}

func zipSource(t *testing.T, name, format string, entries []zipFixture) Source {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, entry := range entries {
		part, createErr := writer.Create(entry.name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := part.Write(entry.body); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	return Source{Path: path, Format: format, Title: "Imported", FileName: name, MediaType: "application/octet-stream", Bytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:])}
}

func fixtureSource(t *testing.T, name, format string, body []byte) Source {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	return Source{Path: path, Format: format, Title: "Imported", FileName: name, MediaType: "application/octet-stream", Bytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:])}
}

func testLimits() Limits {
	return Limits{
		MaxSourceBytes: 100 << 20, MaxPlanBytes: 16 << 20, MaxBodyBytes: 8 << 20,
		MaxEntryBytes: 8 << 20, MaxItems: 200, MaxDepth: 32, PDFTimeoutSecs: 5,
	}
}

func docxPNG(width, height uint32) []byte {
	body := append([]byte{}, []byte{137, 80, 78, 71, 13, 10, 26, 10}...)
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8
	ihdr[9] = 6
	body = appendDOCXPNGChunk(body, "IHDR", ihdr)
	return appendDOCXPNGChunk(body, "IDAT", nil)
}

func appendDOCXPNGChunk(target []byte, kind string, data []byte) []byte {
	chunk := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(chunk[0:4], uint32(len(data)))
	copy(chunk[4:8], kind)
	copy(chunk[8:], data)
	binary.BigEndian.PutUint32(chunk[8+len(data):], crc32.ChecksumIEEE(chunk[4:8+len(data)]))
	return append(target, chunk...)
}

func TestNixImportCarriesNoteCommentsAndStillImportsWithoutThem(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	for _, withComments := range []bool{true, false} {
		manifest, _ := json.Marshal(map[string]any{
			"format": "nix-archive", "formatVersion": 1, "schemaVersion": 3,
			"exportedAt": "2026-09-01T12:00:00Z", "root": id, "rootEffectiveSchema": nil, "includesDeleted": false,
			"items":   []any{map[string]any{"id": id, "parentId": nil, "seq": "1024", "title": "Root", "type": "note"}},
			"omitted": []any{}, "loss": []any{},
		})
		bundle := map[string]any{
			"id": id, "parentId": nil, "workspaceId": "33333333-3333-4333-8333-333333333333", "type": "note", "title": "Root",
			"seq": "1024", "lifecycleState": "active", "createdAt": "2026-09-01T12:00:00Z", "updatedAt": "2026-09-01T12:00:00Z",
			"properties": map[string]any{"title": "Root"}, "schema": nil, "views": nil, "viewRows": []any{}, "viewRowsTruncated": false,
			"body": map[string]any{"schemaVersion": 3, "prosemirror": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph"}}}},
		}
		if withComments {
			bundle["comments"] = []any{map[string]any{"id": "t", "quote": "the plan", "resolved": true, "comments": []any{
				map[string]any{"author": "Ada", "body": "Why?", "createdAt": "2026-10-29T10:00:00Z"}}}}
		}
		bundleBytes, _ := json.Marshal(bundle)
		source := zipSource(t, "c.nix", "nix", []zipFixture{{"manifest.json", manifest}, {"items/" + id + ".json", bundleBytes}})

		plan, err := Parse(context.Background(), source, testLimits())

		if err != nil {
			t.Fatalf("withComments=%v: %v", withComments, err)
		}
		got := string(plan.Items[0].Comments)
		if withComments != strings.Contains(got, `"author":"Ada"`) || (!withComments && got != "") {
			t.Fatalf("withComments=%v comments = %q", withComments, got)
		}
	}
}
