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
		{name: "two roles", input: "import,export", want: []Service{Import, Export}},
		{name: "spaces and trailing comma", input: "import, export ,", want: []Service{Import, Export}},
		{name: "single role", input: "calendar", want: []Service{Calendar}},
		{name: "empty", input: "", wantErr: "at least one"},
		{name: "only commas", input: ",,", wantErr: "at least one"},
		{name: "unknown role", input: "import,bogus", wantErr: "bogus"},
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
	set := Set{Import: true}
	if !set.Has(Import) {
		t.Fatal("Has(Import) = false, want true")
	}
	if set.Has(Export) {
		t.Fatal("Has(Export) = true, want false")
	}
}
