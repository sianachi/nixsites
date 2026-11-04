package role

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    []Service
		wantErr string
	}{
		{name: "repeated role", input: "plugin-events,plugin-events", want: []Service{Plugin}},
		{name: "spaces and trailing comma", input: " plugin-events ,", want: []Service{Plugin}},
		{name: "single role", input: "plugin-events", want: []Service{Plugin}},
		{name: "empty", input: "", wantErr: "at least one"},
		{name: "only commas", input: ",,", wantErr: "at least one"},
		{name: "unknown role", input: "plugin-events,bogus", wantErr: "bogus"},
		{name: "all is not parseable", input: "all", wantErr: "all"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse(tc.input)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("Parse(%q) error = %v, want containing %q", tc.input, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Parse(%q) error = %v", tc.input, err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("Parse(%q) = %v, want %v", tc.input, got, tc.want)
			}
			for _, service := range tc.want {
				if !got.Has(service) {
					t.Fatalf("Parse(%q) missing %q", tc.input, service)
				}
			}
		})
	}
}

func TestSetHas(t *testing.T) {
	set := Set{Plugin: true}
	if !set.Has(Plugin) {
		t.Fatal("Has(Plugin) = false, want true")
	}
	if set.Has(All) {
		t.Fatal("Has(All) = true, want false")
	}
}
