package exporter

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// ProjectTitle keeps a title to one safe line for a file name, a heading or an XML text node.
func ProjectTitle(value string) (string, bool) {
	var output strings.Builder
	lost := false
	space := false
	for _, character := range value {
		if character == '\n' || character == '\r' || character == '\t' {
			space = output.Len() > 0
			lost = true
			continue
		}
		if !validXMLTextRune(character) || unicode.IsControl(character) {
			lost = true
			continue
		}
		if space && character != ' ' {
			output.WriteByte(' ')
		}
		space = false
		output.WriteRune(character)
	}
	title := strings.TrimSpace(output.String())
	if title == "" {
		title = "Untitled"
		lost = true
	}
	return title, lost
}

func sanitizeText(value string) string {
	result, _ := sanitizeTextDetailed(value)
	return result
}

// sanitizeTextDetailed drops what no document format can carry: control characters and runes
// outside the XML text range. Line breaks and tabs stay.
func sanitizeTextDetailed(value string) (string, bool) {
	var output strings.Builder
	output.Grow(len(value))
	changed := false
	for index := 0; index < len(value); {
		character, size := utf8.DecodeRuneInString(value[index:])
		index += size
		if character == '\r' {
			if index < len(value) && value[index] == '\n' {
				index++
			}
			output.WriteByte('\n')
			changed = true
			continue
		}
		if character == '\n' || character == '\t' {
			output.WriteRune(character)
			continue
		}
		if character >= 32 && validXMLTextRune(character) && !unicode.IsControl(character) {
			output.WriteRune(character)
			continue
		}
		changed = true
	}
	return output.String(), changed
}

func validXMLTextRune(character rune) bool {
	return character == '\t' || character == '\n' || character == '\r' ||
		character >= 0x20 && character <= 0xd7ff ||
		character >= 0xe000 && character <= 0xfffd ||
		character >= 0x10000 && character <= 0x10ffff
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
