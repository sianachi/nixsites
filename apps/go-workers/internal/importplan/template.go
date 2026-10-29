package importplan

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

const TemplatePlanVersion = 1

var (
	templateKeyPattern        = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$`)
	templateInputKeyPattern   = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	initializationUUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	initializationTimePattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
	sha256Pattern             = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// TemplateProfile is the additive profile carried by a reusable .nix archive.
type TemplateProfile struct {
	Kind            string                  `json:"kind"`
	Version         int                     `json:"version"`
	Key             string                  `json:"key"`
	Name            string                  `json:"name"`
	Description     string                  `json:"description"`
	IncludeBody     bool                    `json:"includeBody"`
	IncludeChildren bool                    `json:"includeChildren"`
	Initialization  *TemplateInitialization `json:"initialization,omitempty"`
}

type TemplateInitialization struct {
	Version    int                           `json:"version"`
	Inputs     []TemplateInitializationInput `json:"inputs"`
	Rules      []TemplateInitializationRule  `json:"rules"`
	References []TemplateReferenceRule       `json:"references"`
}

type TemplateInitializationInput struct {
	Key          string  `json:"key"`
	Label        string  `json:"label"`
	Type         string  `json:"type"`
	Required     bool    `json:"required"`
	DefaultValue *string `json:"defaultValue,omitempty"`
}

func (input *TemplateInitializationInput) UnmarshalJSON(body []byte) error {
	var value struct {
		Key          *string `json:"key"`
		Label        *string `json:"label"`
		Type         *string `json:"type"`
		Required     *bool   `json:"required"`
		DefaultValue *string `json:"defaultValue"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if value.Key == nil || value.Label == nil || value.Type == nil || value.Required == nil {
		return errors.New("template initialization input is missing a required field")
	}
	*input = TemplateInitializationInput{Key: *value.Key, Label: *value.Label, Type: *value.Type, Required: *value.Required, DefaultValue: value.DefaultValue}
	return nil
}

type TemplateInitializationRule struct {
	SourceID    string          `json:"sourceId"`
	PropertyKey string          `json:"propertyKey"`
	Kind        string          `json:"kind"`
	Value       json.RawMessage `json:"value,omitempty"`
	InputKey    *string         `json:"inputKey,omitempty"`
	OffsetDays  *int            `json:"offsetDays,omitempty"`
	TimeOfDay   *string         `json:"timeOfDay,omitempty"`
	TimeZone    *string         `json:"timeZone,omitempty"`
}

type TemplateReferenceRule struct {
	SourceItemID string  `json:"sourceItemId"`
	Policy       string  `json:"policy"`
	InputKey     *string `json:"inputKey,omitempty"`
}

func (profile *TemplateProfile) UnmarshalJSON(body []byte) error {
	var value struct {
		Kind            *string                 `json:"kind"`
		Version         *int                    `json:"version"`
		Key             *string                 `json:"key"`
		Name            *string                 `json:"name"`
		Description     *string                 `json:"description"`
		IncludeBody     *bool                   `json:"includeBody"`
		IncludeChildren *bool                   `json:"includeChildren"`
		Initialization  *TemplateInitialization `json:"initialization"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("template profile contains multiple JSON values")
		}
		return err
	}
	if value.Kind == nil || value.Version == nil || value.Key == nil || value.Name == nil || value.Description == nil || value.IncludeBody == nil || value.IncludeChildren == nil {
		return errors.New("the template profile is incomplete")
	}
	*profile = TemplateProfile{
		Kind: *value.Kind, Version: *value.Version, Key: *value.Key, Name: *value.Name,
		Description: *value.Description, IncludeBody: *value.IncludeBody, IncludeChildren: *value.IncludeChildren,
		Initialization: value.Initialization,
	}
	return nil
}

// TemplatePlan is the bounded, deterministic handoff between preview and commit.
type TemplatePlan struct {
	Version      int                           `json:"version"`
	SourceSHA256 string                        `json:"sourceSha256"`
	Profile      TemplateProfile               `json:"profile"`
	RootItemType string                        `json:"rootItemType"`
	ItemCount    int                           `json:"itemCount"`
	BodyCount    int                           `json:"bodyCount"`
	ViewCount    int                           `json:"viewCount"`
	Items        []TemplateItem                `json:"items"`
	Files        []nixarchive.FileVersionEntry `json:"files,omitempty"`
}

// TemplateItem preserves the archive's portable identity, parentage, signed sequence, and body.
type TemplateItem struct {
	SourceID       string          `json:"sourceId"`
	ParentSourceID *string         `json:"parentSourceId"`
	Sequence       string          `json:"seq"`
	Title          string          `json:"title"`
	ItemType       string          `json:"itemType"`
	Properties     json.RawMessage `json:"properties"`
	Schema         json.RawMessage `json:"schema"`
	Views          json.RawMessage `json:"views"`
	Body           json.RawMessage `json:"body"`
	Recurrence     json.RawMessage `json:"recurrence,omitempty"`
}

// ParseTemplate validates a template-profile .nix archive through the same bounded archive reader
// used by ordinary imports, then normalizes only the data required for durable staging.
func ParseTemplate(ctx context.Context, source Source, limits Limits) (TemplatePlan, error) {
	if err := validateSource(source, limits); err != nil {
		return TemplatePlan{}, err
	}
	if normalizeFormat(source.Format) != "nix" {
		return TemplatePlan{}, fmt.Errorf("%w: %s", ErrUnsupportedFormat, source.Format)
	}
	parsed, err := validateNixArchive(ctx, source, limits)
	if err != nil {
		return TemplatePlan{}, err
	}
	if len(parsed.manifest.Omitted) != 0 || len(parsed.manifest.Loss) != 0 {
		return TemplatePlan{}, errors.New("a template archive cannot contain omissions or loss")
	}
	var profile TemplateProfile
	if isJSONNull(parsed.manifest.Profile) {
		return TemplatePlan{}, errors.New("the Nix archive does not contain a template profile")
	}
	if err := decodeStrictJSON(parsed.manifest.Profile, &profile); err != nil {
		return TemplatePlan{}, fmt.Errorf("decode template profile: %w", err)
	}
	if err := validateTemplateProfile(profile); err != nil {
		return TemplatePlan{}, err
	}
	if profile.Initialization != nil {
		included := make(map[string]struct{}, len(parsed.items))
		for _, item := range parsed.items {
			included[item.manifest.ID] = struct{}{}
		}
		for _, rule := range profile.Initialization.Rules {
			if _, ok := included[rule.SourceID]; !ok {
				return TemplatePlan{}, errors.New("template initialization refers to an item outside the archive")
			}
		}
	}
	if !profile.IncludeChildren && len(parsed.items) != 1 {
		return TemplatePlan{}, errors.New("the template profile excludes children but the archive contains descendants")
	}

	plan := TemplatePlan{
		Version: TemplatePlanVersion, SourceSHA256: strings.ToLower(source.SHA256), Profile: profile,
		ItemCount: len(parsed.items), Items: make([]TemplateItem, 0, len(parsed.items)), Files: parsed.files,
	}
	for _, parsedItem := range parsed.items {
		if err := ctx.Err(); err != nil {
			return TemplatePlan{}, err
		}
		entry := parsedItem.manifest
		bundle := parsedItem.bundle
		views := cloneNullableJSON(bundle.Views)
		viewCount, err := countTemplateViews(views)
		if err != nil {
			return TemplatePlan{}, fmt.Errorf("Nix item %s: %w", entry.ID, err)
		}
		plan.ViewCount += viewCount
		body := cloneNullableJSON(bundle.Body)
		if body != nil {
			plan.BodyCount++
		}
		if entry.ID == parsed.manifest.Root {
			plan.RootItemType = bundle.Type
			if !profile.IncludeBody && body != nil {
				return TemplatePlan{}, errors.New("the template profile excludes the root body but the archive contains it")
			}
		}
		// Templates are starting points: bundle.Comments from a document export are dropped here, never planned or imported.
		plan.Items = append(plan.Items, TemplateItem{
			SourceID: entry.ID, ParentSourceID: cloneOptionalString(entry.ParentID), Sequence: entry.Sequence,
			Title: bundle.Title, ItemType: bundle.Type, Properties: cloneJSON(bundle.Properties),
			Schema: importNixSchema(entry.ID == parsed.manifest.Root, parsed.manifest.RootEffectiveSchema, bundle.Schema),
			Views:  views, Body: body, Recurrence: cloneNullableJSON(bundle.Recurrence),
		})
	}
	if err := validateTemplatePlan(plan, &limits); err != nil {
		return TemplatePlan{}, err
	}
	return plan, nil
}

// EncodeTemplate returns stable JSON and its lowercase SHA-256 digest.
func EncodeTemplate(plan TemplatePlan, maxBytes int64) ([]byte, string, error) {
	if maxBytes <= 0 {
		return nil, "", errors.New("template plan byte limit must be positive")
	}
	if err := validateTemplatePlan(plan, nil); err != nil {
		return nil, "", err
	}
	body, err := json.Marshal(plan)
	if err != nil {
		return nil, "", err
	}
	if int64(len(body)) > maxBytes {
		return nil, "", errors.New("template plan exceeds the configured byte limit")
	}
	digest := sha256.Sum256(body)
	return body, hex.EncodeToString(digest[:]), nil
}

// DecodeTemplate verifies the preview digest and validates the persisted plan before commit.
func DecodeTemplate(body []byte, expectedDigest string, limits Limits) (TemplatePlan, error) {
	if int64(len(body)) > limits.MaxPlanBytes {
		return TemplatePlan{}, errors.New("template plan exceeds the configured byte limit")
	}
	digest := sha256.Sum256(body)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), expectedDigest) {
		return TemplatePlan{}, errors.New("template plan checksum does not match the preview")
	}
	if err := validateJSONDepth(body, limits.MaxDepth+8); err != nil {
		return TemplatePlan{}, fmt.Errorf("template plan JSON: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var plan TemplatePlan
	if err := decoder.Decode(&plan); err != nil {
		return TemplatePlan{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return TemplatePlan{}, errors.New("template plan contains multiple JSON values")
		}
		return TemplatePlan{}, err
	}
	if err := validateTemplatePlan(plan, &limits); err != nil {
		return TemplatePlan{}, err
	}
	return plan, nil
}

func validateTemplateProfile(profile TemplateProfile) error {
	if profile.Kind != "template" || profile.Version != 1 {
		return errors.New("the template profile kind or version is unsupported")
	}
	if !templateKeyPattern.MatchString(profile.Key) || !boundedText(profile.Name, 200, false) || !boundedText(profile.Description, 1000, true) {
		return errors.New("the template profile key, name, or description is invalid")
	}
	if err := validateTemplateInitialization(profile.Initialization); err != nil {
		return err
	}
	return nil
}

func validateTemplateInitialization(value *TemplateInitialization) error {
	if value == nil {
		return nil
	}
	if value.Version != 1 || value.Inputs == nil || value.Rules == nil || value.References == nil || len(value.Inputs) > 100 || len(value.Rules)+len(value.References) > 2000 {
		return errors.New("template initialization metadata is invalid")
	}
	inputKeys := make(map[string]string, len(value.Inputs))
	for _, input := range value.Inputs {
		if !templateInputKeyPattern.MatchString(input.Key) || !boundedText(input.Label, 120, false) ||
			(input.Type != "text" && input.Type != "date" && input.Type != "member" && input.Type != "item") {
			return errors.New("template initialization inputs are invalid")
		}
		if input.DefaultValue != nil && !validInitializationDefault(input.Type, *input.DefaultValue) {
			return errors.New("template initialization default value is invalid")
		}
		if _, duplicate := inputKeys[input.Key]; duplicate {
			return errors.New("template initialization inputs contain duplicate keys")
		}
		inputKeys[input.Key] = input.Type
	}
	seenRules := make(map[string]struct{}, len(value.Rules))
	for _, rule := range value.Rules {
		if !validArchiveID(rule.SourceID) || !boundedText(rule.PropertyKey, 160, false) ||
			(rule.Kind != "keep" && rule.Kind != "clear" && rule.Kind != "set" && rule.Kind != "input" && rule.Kind != "relativeDate") ||
			(rule.InputKey != nil && len(*rule.InputKey) > 64) || (rule.TimeOfDay != nil && len(*rule.TimeOfDay) > 32) || (rule.TimeZone != nil && len(*rule.TimeZone) > 128) {
			return errors.New("template initialization rules are invalid")
		}
		identity := rule.SourceID + "\x00" + rule.PropertyKey
		if _, duplicate := seenRules[identity]; duplicate {
			return errors.New("template initialization rules contain duplicate targets")
		}
		seenRules[identity] = struct{}{}
		hasValue := len(bytes.TrimSpace(rule.Value)) > 0 && !bytes.Equal(bytes.TrimSpace(rule.Value), []byte("null"))
		hasInput := rule.InputKey != nil
		hasOffset := rule.OffsetDays != nil
		hasTime := rule.TimeOfDay != nil
		hasZone := rule.TimeZone != nil
		switch rule.Kind {
		case "keep", "clear":
			if hasValue || hasInput || hasOffset || hasTime || hasZone {
				return errors.New("keep and clear initialization rules must not carry value or date fields")
			}
		case "set":
			if !hasValue || hasInput || hasOffset || hasTime || hasZone {
				return errors.New("set initialization rules must carry only a non-null value")
			}
			if rule.PropertyKey == "recurrence.until" {
				var date string
				if err := json.Unmarshal(rule.Value, &date); err != nil || !validInitializationDefault("date", date) {
					return errors.New("a set recurrence end rule requires an ISO calendar day value")
				}
			}
		case "input":
			if hasValue || !hasInput || inputKeys[*rule.InputKey] == "" || hasOffset || hasTime || hasZone {
				return errors.New("input initialization rules must refer only to a declared input")
			}
			if rule.PropertyKey == "recurrence.until" && inputKeys[*rule.InputKey] != "date" {
				return errors.New("the recurrence end rule requires a date input")
			}
		case "relativeDate":
			if hasValue || !hasInput || inputKeys[*rule.InputKey] != "date" || !hasOffset || *rule.OffsetDays < -36500 || *rule.OffsetDays > 36500 {
				return errors.New("a relative-date rule requires a date input and a bounded integer offset")
			}
			if rule.PropertyKey == "recurrence.until" {
				if hasTime || hasZone {
					return errors.New("the recurrence end rule accepts no time fields")
				}
			} else if hasTime != hasZone || (hasTime && !initializationTimePattern.MatchString(*rule.TimeOfDay)) || (hasZone && strings.TrimSpace(*rule.TimeZone) == "") {
				return errors.New("relative timestamp rules require a valid time and time zone together")
			}
		}
	}
	seenReferences := make(map[string]struct{}, len(value.References))
	for _, reference := range value.References {
		if !validArchiveID(reference.SourceItemID) ||
			(reference.Policy != "retain" && reference.Policy != "omit" && reference.Policy != "replace") ||
			(reference.InputKey != nil && len(*reference.InputKey) > 64) {
			return errors.New("template initialization reference policies are invalid")
		}
		if _, duplicate := seenReferences[reference.SourceItemID]; duplicate {
			return errors.New("template initialization contains duplicate reference policies")
		}
		seenReferences[reference.SourceItemID] = struct{}{}
		if reference.Policy == "replace" && (reference.InputKey == nil || inputKeys[*reference.InputKey] != "item") {
			return errors.New("a replacement reference requires a declared item input")
		}
		if reference.Policy != "replace" && reference.InputKey != nil {
			return errors.New("retain and omit references must not carry an input key")
		}
	}
	return nil
}

func validInitializationDefault(inputType, value string) bool {
	switch inputType {
	case "text":
		return len(value) <= 4096
	case "date":
		parsed, err := time.Parse("2006-01-02", value)
		return err == nil && parsed.Format("2006-01-02") == value
	case "member", "item":
		return initializationUUIDPattern.MatchString(value)
	default:
		return false
	}
}

func validateTemplatePlan(plan TemplatePlan, limits *Limits) error {
	if plan.Version != TemplatePlanVersion || !sha256Pattern.MatchString(plan.SourceSHA256) || validateTemplateProfile(plan.Profile) != nil || len(plan.Items) == 0 {
		return errors.New("template plan metadata is invalid")
	}
	if limits != nil && (len(plan.Items) > limits.MaxItems || limits.MaxDepth <= 0 || limits.MaxBodyBytes <= 0) {
		return errors.New("template plan exceeds the configured limits")
	}
	if plan.Files != nil {
		if limits != nil && len(plan.Files) > limits.MaxItems*nixarchive.MaxFileVersionsPerItem {
			return errors.New("template plan declares too many file versions")
		}
		manifestItems := make([]nixarchive.ManifestItem, 0, len(plan.Items))
		for _, item := range plan.Items {
			manifestItems = append(manifestItems, nixarchive.ManifestItem{ID: item.SourceID, Type: item.ItemType})
		}
		if err := nixarchive.ValidateFileVersions(plan.Files, manifestItems); err != nil {
			return err
		}
	}
	seen := make(map[string]struct{}, len(plan.Items))
	depths := make(map[string]int, len(plan.Items))
	rootCount, bodyCount, viewCount := 0, 0, 0
	rootType := ""
	rootHasBody := false
	for _, item := range plan.Items {
		if !validArchiveID(item.SourceID) || !validIntegerString(item.Sequence) || !boundedText(item.Title, 500, true) || !boundedText(item.ItemType, 64, false) || !isJSONObject(item.Properties) {
			return errors.New("template plan contains an invalid item envelope")
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return errors.New("template plan contains a duplicate source item")
		}
		depth := 0
		if item.ParentSourceID == nil {
			rootCount++
			rootType = item.ItemType
			rootHasBody = !isJSONNull(item.Body)
		} else {
			if !validArchiveID(*item.ParentSourceID) {
				return errors.New("template plan contains an invalid parent source item")
			}
			if _, parentSeen := seen[*item.ParentSourceID]; !parentSeen {
				return errors.New("template plan items are not parent-first")
			}
			depth = depths[*item.ParentSourceID] + 1
		}
		if limits != nil && depth > limits.MaxDepth {
			return errors.New("template plan tree is too deep")
		}
		depths[item.SourceID] = depth
		seen[item.SourceID] = struct{}{}
		if limits != nil {
			for name, value := range map[string]json.RawMessage{
				"properties": item.Properties,
				"schema":     item.Schema,
				"views":      item.Views,
				"body":       item.Body,
				"recurrence": item.Recurrence,
			} {
				if err := validateJSONDepth(value, limits.MaxDepth); err != nil {
					return fmt.Errorf("template plan item %s %s: %w", item.SourceID, name, err)
				}
			}
		}
		if !isJSONNull(item.Schema) && !isJSONObject(item.Schema) {
			return errors.New("template plan contains an invalid property schema")
		}
		if !isJSONNull(item.Views) && !isJSONObject(item.Views) {
			return errors.New("template plan contains invalid views")
		}
		if !isJSONNull(item.Body) {
			if !isJSONObject(item.Body) || limits != nil && int64(len(item.Body)) > limits.MaxBodyBytes {
				return errors.New("template plan contains an invalid or oversized body")
			}
			bodyCount++
		}
		count, err := countTemplateViews(item.Views)
		if err != nil {
			return err
		}
		viewCount += count
	}
	if rootCount != 1 || rootType != plan.RootItemType || plan.ItemCount != len(plan.Items) || plan.BodyCount != bodyCount || plan.ViewCount != viewCount {
		return errors.New("template plan counts or root metadata are inconsistent")
	}
	if !plan.Profile.IncludeChildren && len(plan.Items) != 1 {
		return errors.New("template plan descendants disagree with its profile")
	}
	if !plan.Profile.IncludeBody && rootHasBody {
		return errors.New("template plan root body disagrees with its profile")
	}
	return nil
}

// validateJSONDepth bounds attacker-controlled nesting without materializing another decoded tree.
// The strict decoders remain responsible for complete JSON syntax validation.
func validateJSONDepth(body []byte, maximum int) error {
	if maximum <= 0 {
		return errors.New("JSON depth limit must be positive")
	}
	depth := 0
	inString := false
	escaped := false
	for _, value := range body {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch value {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch value {
		case '"':
			inString = true
		case '{', '[':
			depth++
			if depth > maximum {
				return errors.New("JSON nesting exceeds the configured depth limit")
			}
		case '}', ']':
			depth--
			if depth < 0 {
				return errors.New("JSON nesting is malformed")
			}
		}
	}
	if inString || depth != 0 {
		return errors.New("JSON nesting is malformed")
	}
	return nil
}

func countTemplateViews(value json.RawMessage) (int, error) {
	if isJSONNull(value) {
		return 0, nil
	}
	var snapshot struct {
		Views   []json.RawMessage `json:"views"`
		Default string            `json:"default"`
	}
	if err := decodeStrictJSON(value, &snapshot); err != nil || snapshot.Views == nil {
		return 0, errors.New("template item views are invalid")
	}
	return len(snapshot.Views), nil
}

func boundedText(value string, maximum int, allowEmpty bool) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= maximum && (allowEmpty || strings.TrimSpace(value) != "")
}

func cloneOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
