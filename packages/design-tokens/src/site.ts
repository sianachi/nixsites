/**
 * The colours a published Nix site is drawn with (ADR-0063).
 *
 * **Here for the same reason as `print.ts`.** The site renderer writes its stylesheet as a string,
 * and `scripts/check-raw-design-values.sh` exempts only this directory, so every colour the site
 * theme uses is declared here and nowhere else. `site.test.ts` traces each role to the token sheet
 * and asserts the contrast the theme relies on, so this cannot drift into a second palette.
 *
 * **Both grounds, unlike print.** A site follows the reader's colour scheme and offers a toggle,
 * so the dark values are taken from the sheet's dark ground in the same way.
 */

interface SiteSyntax {
  readonly keyword: string;
  readonly string: string;
  readonly number: string;
  readonly comment: string;
  readonly title: string;
  readonly type: string;
}

export interface SiteGround {
  /** The page. */
  readonly ground: string;
  /** Cards, the sidebar's current row, table headers. */
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  /** Hairlines between regions. */
  readonly border: string;
  /** Link text, at body size. */
  readonly link: string;
  /** Behind code blocks and inline code. */
  readonly code: string;
  /** Behind highlighted text and search matches. */
  readonly mark: string;
  /** The accent a site uses when its settings name none. */
  readonly accent: string;
  /** Text set on the accent. */
  readonly onAccent: string;
  readonly syntax: SiteSyntax;
  /** Chart series one to six, then the "Other" series. */
  readonly series: readonly string[];
}

export interface SitePalette {
  readonly light: SiteGround;
  readonly dark: SiteGround;
}

export const SITE_PALETTE: SitePalette = {
  light: {
    ground: '#f5f5f8',
    surface: '#e9e9ea',
    text: '#1d1f20',
    muted: '#5d5d60',
    border: '#d4d4d7',
    link: '#416180',
    code: '#e7e7ea',
    mark: '#d6ebff',
    accent: '#416180',
    onAccent: '#f5f5f8',
    syntax: {
      keyword: '#72437c',
      string: '#2a6d62',
      number: '#374d21',
      comment: '#5d5d60',
      title: '#416180',
      type: '#2c455d',
    },
    series: ['#5087bd', '#a16428', '#2a6d62', '#72437c', '#374d21', '#383838', '#5d5d60'],
  },
  dark: {
    ground: '#17181a',
    surface: '#1f2123',
    text: '#e8e9ea',
    muted: '#b7b7ba',
    border: '#424244',
    link: '#b5d9fd',
    code: '#1f2123',
    mark: '#2c455d',
    accent: '#b5d9fd',
    onAccent: '#17181a',
    syntax: {
      keyword: '#96b7d7',
      string: '#97d7cd',
      number: '#dbe9cd',
      comment: '#b7b7ba',
      title: '#b5d9fd',
      type: '#d6ebff',
    },
    series: ['#96b7d7', '#bd762f', '#97d7cd', '#9a5ba6', '#dbe9cd', '#9c9c9c', '#b7b7ba'],
  },
};
