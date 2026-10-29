export interface MermaidFamilyFixture {
  readonly id: string;
  readonly diagramType: string;
  readonly source: string;
  readonly sourceUrl: string;
}

// Examples from the installed Mermaid release; parsing does not prove canvas conversion or export.
export const MERMAID_FAMILY_FIXTURES: readonly MermaidFamilyFixture[] = [
  {
    id: 'architecture-beta',
    diagramType: 'architecture',
    source: `architecture-beta
    group api(cloud)[API]

    service db(database)[Database] in api
    service disk1(disk)[Storage] in api
    service disk2(disk)[Storage] in api
    service server(server)[Server] in api

    db:L -- R:server
    disk1:T -- B:server
    disk2:T -- B:db`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/architecture.md',
  },
  {
    id: 'block',
    diagramType: 'block',
    source: `block
columns 1
  db(("DB"))
  blockArrowId6<["&nbsp;&nbsp;&nbsp;"]>(down)
  block:ID
    A
    B["A wide one in the middle"]
    C
  end
  space
  D
  ID --> D
  C --> D
  style B fill:#969,stroke:#333,stroke-width:4px`, // design-token-exempt: upstream Mermaid syntax fixture, not Nix UI colours.
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/block.md',
  },
  {
    id: 'c4context',
    diagramType: 'c4',
    source: `C4Context
      title System Context diagram for Internet Banking System
      Enterprise_Boundary(b0, "BankBoundary0") {
        Person(customerA, "Banking Customer A", "A customer of the bank, with personal bank accounts.")
        Person(customerB, "Banking Customer B")
        Person_Ext(customerC, "Banking Customer C", "desc")

        Person(customerD, "Banking Customer D", "A customer of the bank, <br/> with personal bank accounts.")

        System(SystemAA, "Internet Banking System", "Allows customers to view information about their bank accounts, and make payments.")

        Enterprise_Boundary(b1, "BankBoundary") {

          SystemDb_Ext(SystemE, "Mainframe Banking System", "Stores all of the core banking information about customers, accounts, transactions, etc.")

          System_Boundary(b2, "BankBoundary2") {
            System(SystemA, "Banking System A")
            System(SystemB, "Banking System B", "A system of the bank, with personal bank accounts. next line.")
          }

          System_Ext(SystemC, "E-mail system", "The internal Microsoft Exchange e-mail system.")
          SystemDb(SystemD, "Banking System D Database", "A system of the bank, with personal bank accounts.")

          Boundary(b3, "BankBoundary3", "boundary") {
            SystemQueue(SystemF, "Banking System F Queue", "A system of the bank.")
            SystemQueue_Ext(SystemG, "Banking System G Queue", "A system of the bank, with personal bank accounts.")
          }
        }
      }

      BiRel(customerA, SystemAA, "Uses")
      BiRel(SystemAA, SystemE, "Uses")
      Rel(SystemAA, SystemC, "Sends e-mails", "SMTP")
      Rel(SystemC, customerA, "Sends e-mails to")

      UpdateElementStyle(customerA, $fontColor="red", $bgColor="grey", $borderColor="red")
      UpdateRelStyle(customerA, SystemAA, $textColor="blue", $lineColor="blue", $offsetX="5")
      UpdateRelStyle(SystemAA, SystemE, $textColor="blue", $lineColor="blue", $offsetY="-10")
      UpdateRelStyle(SystemAA, SystemC, $textColor="blue", $lineColor="blue", $offsetY="-40", $offsetX="-50")
      UpdateRelStyle(SystemC, customerA, $textColor="red", $lineColor="red", $offsetX="-50", $offsetY="20")

      UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/c4.md',
  },
  {
    id: 'c4container',
    diagramType: 'c4',
    source: `C4Container
    title Container diagram for Internet Banking System

    System_Ext(email_system, "E-Mail System", "The internal Microsoft Exchange system", $tags="v1.0")
    Person(customer, Customer, "A customer of the bank, with personal bank accounts", $tags="v1.0")

    Container_Boundary(c1, "Internet Banking") {
        Container(spa, "Single-Page App", "JavaScript, Angular", "Provides all the Internet banking functionality to customers via their web browser")
        Container_Ext(mobile_app, "Mobile App", "C#, Xamarin", "Provides a limited subset of the Internet banking functionality to customers via their mobile device")
        Container(web_app, "Web Application", "Java, Spring MVC", "Delivers the static content and the Internet banking SPA")
        ContainerDb(database, "Database", "SQL Database", "Stores user registration information, hashed auth credentials, access logs, etc.")
        ContainerDb_Ext(backend_api, "API Application", "Java, Docker Container", "Provides Internet banking functionality via API")

    }

    System_Ext(banking_system, "Mainframe Banking System", "Stores all of the core banking information about customers, accounts, transactions, etc.")

    Rel(customer, web_app, "Uses", "HTTPS")
    UpdateRelStyle(customer, web_app, $offsetY="60", $offsetX="90")
    Rel(customer, spa, "Uses", "HTTPS")
    UpdateRelStyle(customer, spa, $offsetY="-40")
    Rel(customer, mobile_app, "Uses")
    UpdateRelStyle(customer, mobile_app, $offsetY="-30")

    Rel(web_app, spa, "Delivers")
    UpdateRelStyle(web_app, spa, $offsetX="130")
    Rel(spa, backend_api, "Uses", "async, JSON/HTTPS")
    Rel(mobile_app, backend_api, "Uses", "async, JSON/HTTPS")
    Rel_Back(database, backend_api, "Reads from and writes to", "sync, JDBC")

    Rel(email_system, customer, "Sends e-mails to")
    UpdateRelStyle(email_system, customer, $offsetX="-45")
    Rel(backend_api, email_system, "Sends e-mails using", "sync, SMTP")
    UpdateRelStyle(backend_api, email_system, $offsetY="-60")
    Rel(backend_api, banking_system, "Uses", "sync/async, XML/HTTPS")
    UpdateRelStyle(backend_api, banking_system, $offsetY="-50", $offsetX="-140")`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/c4.md',
  },
  {
    id: 'c4component',
    diagramType: 'c4',
    source: `C4Component
    title Component diagram for Internet Banking System - API Application

    Container(spa, "Single Page Application", "javascript and angular", "Provides all the internet banking functionality to customers via their web browser.")
    Container(ma, "Mobile App", "Xamarin", "Provides a limited subset to the internet banking functionality to customers via their mobile device.")
    ContainerDb(db, "Database", "Relational Database Schema", "Stores user registration information, hashed authentication credentials, access logs, etc.")
    System_Ext(mbs, "Mainframe Banking System", "Stores all of the core banking information about customers, accounts, transactions, etc.")

    Container_Boundary(api, "API Application") {
        Component(sign, "Sign In Controller", "MVC Rest Controller", "Allows users to sign in to the internet banking system")
        Component(accounts, "Accounts Summary Controller", "MVC Rest Controller", "Provides customers with a summary of their bank accounts")
        Component(security, "Security Component", "Spring Bean", "Provides functionality related to singing in, changing passwords, etc.")
        Component(mbsfacade, "Mainframe Banking System Facade", "Spring Bean", "A facade onto the mainframe banking system.")

        Rel(sign, security, "Uses")
        Rel(accounts, mbsfacade, "Uses")
        Rel(security, db, "Read & write to", "JDBC")
        Rel(mbsfacade, mbs, "Uses", "XML/HTTPS")
    }

    Rel_Back(spa, sign, "Uses", "JSON/HTTPS")
    Rel(spa, accounts, "Uses", "JSON/HTTPS")

    Rel(ma, sign, "Uses", "JSON/HTTPS")
    Rel(ma, accounts, "Uses", "JSON/HTTPS")

    UpdateRelStyle(spa, sign, $offsetY="-40")
    UpdateRelStyle(spa, accounts, $offsetX="40", $offsetY="40")

    UpdateRelStyle(ma, sign, $offsetX="-90", $offsetY="40")
    UpdateRelStyle(ma, accounts, $offsetY="-40")

        UpdateRelStyle(sign, security, $offsetX="-160", $offsetY="10")
        UpdateRelStyle(accounts, mbsfacade, $offsetX="140", $offsetY="10")
        UpdateRelStyle(security, db, $offsetY="-40")
        UpdateRelStyle(mbsfacade, mbs, $offsetY="-40")`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/c4.md',
  },
  {
    id: 'c4dynamic',
    diagramType: 'c4',
    source: `C4Dynamic
    title Dynamic diagram for Internet Banking System - API Application

    ContainerDb(c4, "Database", "Relational Database Schema", "Stores user registration information, hashed authentication credentials, access logs, etc.")
    Container(c1, "Single-Page Application", "JavaScript and Angular", "Provides all of the Internet banking functionality to customers via their web browser.")
    Container_Boundary(b, "API Application") {
      Component(c3, "Security Component", "Spring Bean", "Provides functionality Related to signing in, changing passwords, etc.")
      Component(c2, "Sign In Controller", "Spring MVC Rest Controller", "Allows users to sign in to the Internet Banking System.")
    }
    Rel(c1, c2, "Submits credentials to", "JSON/HTTPS")
    Rel(c2, c3, "Calls isAuthenticated() on")
    Rel(c3, c4, "select * from users where username = ?", "JDBC")

    UpdateRelStyle(c1, c2, $textColor="red", $offsetY="-40")
    UpdateRelStyle(c2, c3, $textColor="red", $offsetX="-40", $offsetY="60")
    UpdateRelStyle(c3, c4, $textColor="red", $offsetY="-40", $offsetX="10")`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/c4.md',
  },
  {
    id: 'c4deployment',
    diagramType: 'c4',
    source: `C4Deployment
    title Deployment Diagram for Internet Banking System - Live

    Deployment_Node(mob, "Customer's mobile device", "Apple IOS or Android"){
        Container(mobile, "Mobile App", "Xamarin", "Provides a limited subset of the Internet Banking functionality to customers via their mobile device.")
    }

    Deployment_Node(comp, "Customer's computer", "Microsoft Windows or Apple macOS"){
        Deployment_Node(browser, "Web Browser", "Google Chrome, Mozilla Firefox,<br/> Apple Safari or Microsoft Edge"){
            Container(spa, "Single Page Application", "JavaScript and Angular", "Provides all of the Internet Banking functionality to customers via their web browser.")
        }
    }

    Deployment_Node(plc, "Big Bank plc", "Big Bank plc data center"){
        Deployment_Node(dn, "bigbank-api*** x8", "Ubuntu 16.04 LTS"){
            Deployment_Node(apache, "Apache Tomcat", "Apache Tomcat 8.x"){
                Container(api, "API Application", "Java and Spring MVC", "Provides Internet Banking functionality via a JSON/HTTPS API.")
            }
        }
        Deployment_Node(bb2, "bigbank-web*** x4", "Ubuntu 16.04 LTS"){
            Deployment_Node(apache2, "Apache Tomcat", "Apache Tomcat 8.x"){
                Container(web, "Web Application", "Java and Spring MVC", "Delivers the static content and the Internet Banking single page application.")
            }
        }
        Deployment_Node(bigbankdb01, "bigbank-db01", "Ubuntu 16.04 LTS"){
            Deployment_Node(oracle, "Oracle - Primary", "Oracle 12c"){
                ContainerDb(db, "Database", "Relational Database Schema", "Stores user registration information, hashed authentication credentials, access logs, etc.")
            }
        }
        Deployment_Node(bigbankdb02, "bigbank-db02", "Ubuntu 16.04 LTS") {
            Deployment_Node(oracle2, "Oracle - Secondary", "Oracle 12c") {
                ContainerDb(db2, "Database", "Relational Database Schema", "Stores user registration information, hashed authentication credentials, access logs, etc.")
            }
        }
    }

    Rel(mobile, api, "Makes API calls to", "json/HTTPS")
    Rel(spa, api, "Makes API calls to", "json/HTTPS")
    Rel_U(web, spa, "Delivers to the customer's web browser")
    Rel(api, db, "Reads from and writes to", "JDBC")
    Rel(api, db2, "Reads from and writes to", "JDBC")
    Rel_R(db, db2, "Replicates data to")

    UpdateRelStyle(spa, api, $offsetY="-40")
    UpdateRelStyle(web, spa, $offsetY="-40")
    UpdateRelStyle(api, db, $offsetY="-20", $offsetX="5")
    UpdateRelStyle(api, db2, $offsetX="-40", $offsetY="-20")
    UpdateRelStyle(db, db2, $offsetY="-10")`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/c4.md',
  },
  {
    id: 'classdiagram',
    diagramType: 'classDiagram',
    source: `---
title: Animal example
---
classDiagram
    note "From Duck till Zebra"
    Animal <|-- Duck
    note for Duck "can fly<br>can swim<br>can dive<br>can help in debugging"
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +int age
    Animal : +String gender
    Animal: +isMammal()
    Animal: +mate()
    class Duck{
        +String beakColor
        +swim()
        +quack()
    }
    class Fish{
        -int sizeInFeet
        -canEat()
    }
    class Zebra{
        +bool is_wild
        +run()
    }`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/classDiagram.md',
  },
  {
    id: 'cynefin-beta',
    diagramType: 'cynefin',
    source: `cynefin-beta
  title Incident Response

  complex
    "Investigate root cause"
    "Run chaos experiment"

  complicated
    "Analyze performance data"
    "Expert review needed"

  clear
    "Restart service"
    "Apply known fix"

  chaotic
    "Page on-call immediately"

  confusion
    "Unknown failure mode"`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/cynefin.md',
  },
  {
    id: 'erdiagram',
    diagramType: 'er',
    source: `---
title: Order example
---
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER }|..|{ DELIVERY-ADDRESS : uses`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/entityRelationshipDiagram.md',
  },
  {
    id: 'eventmodeling',
    diagramType: 'eventmodeling',
    source: `eventmodeling

tf 01 ui CartUI
tf 02 cmd AddItem
tf 03 evt ItemAdded`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/eventmodeling.md',
  },
  {
    id: 'flowchart-lr',
    diagramType: 'flowchart-v2',
    source: `---
title: Node
---
flowchart LR
    id`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/flowchart.md',
  },
  {
    id: 'flowchart-td',
    diagramType: 'flowchart-v2',
    source: `flowchart TD
    Start --> Stop`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/flowchart.md',
  },
  {
    id: 'flowchart-rl',
    diagramType: 'flowchart-v2',
    source: `flowchart RL
    A@{ shape: manual-file, label: "File Handling"}
    B@{ shape: manual-input, label: "User Input"}
    C@{ shape: docs, label: "Multiple Documents"}
    D@{ shape: procs, label: "Process Automation"}
    E@{ shape: paper-tape, label: "Paper Records"}`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/flowchart.md',
  },
  {
    id: 'flowchart-tb',
    diagramType: 'flowchart-v2',
    source: `flowchart TB
    A & B--> C & D`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/flowchart.md',
  },
  {
    id: 'gantt',
    diagramType: 'gantt',
    source: `gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
        A task          :a1, 2014-01-01, 30d
        Another task    :after a1, 20d
    section Another
        Task in Another :2014-01-12, 12d
        another task    :24d`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/gantt.md',
  },
  {
    id: 'gitgraph',
    diagramType: 'gitGraph',
    source: `---
title: Example Git diagram
---
gitGraph
   commit
   commit
   branch develop
   checkout develop
   commit
   commit
   checkout main
   merge develop
   commit
   commit`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/gitgraph.md',
  },
  {
    id: 'gitgraph-lr',
    diagramType: 'gitGraph',
    source: `gitGraph LR:
       commit
       commit
       branch develop
       commit
       commit
       checkout main
       commit
       commit
       merge develop
       commit
       commit`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/gitgraph.md',
  },
  {
    id: 'gitgraph-tb',
    diagramType: 'gitGraph',
    source: `gitGraph TB:
       commit
       commit
       branch develop
       commit
       commit
       checkout main
       commit
       commit
       merge develop
       commit
       commit`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/gitgraph.md',
  },
  {
    id: 'gitgraph-bt',
    diagramType: 'gitGraph',
    source: `gitGraph BT:
       commit
       commit
       branch develop
       commit
       commit
       checkout main
       commit
       commit
       merge develop
       commit
       commit`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/gitgraph.md',
  },
  {
    id: 'gitgraph-parallel-commits-disabled',
    diagramType: 'gitGraph',
    source: `---
config:
  gitGraph:
    parallelCommits: false
---
gitGraph:
  commit
  branch develop
  commit
  commit
  checkout main
  commit
  commit`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/gitgraph.md',
  },
  {
    id: 'ishikawa-beta',
    diagramType: 'ishikawa',
    source: `ishikawa-beta
    Blurry Photo
    Process
        Out of focus
        Shutter speed too slow
        Protective film not removed
        Beautification filter applied
    User
        Shaky hands
    Equipment
        LENS
            Inappropriate lens
            Damaged lens
            Dirty lens
        SENSOR
            Damaged sensor
            Dirty sensor
    Environment
        Subject moved too quickly
        Too dark`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/ishikawa.md',
  },
  {
    id: 'kanban',
    diagramType: 'kanban',
    source: `kanban
  column1[Column Title]
    task1[Task Description]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/kanban.md',
  },
  {
    id: 'mindmap',
    diagramType: 'mindmap',
    source: `mindmap
  root((mindmap))
    Origins
      Long history
      ::icon(fa fa-book)
      Popularisation
        British popular psychology author Tony Buzan
    Research
      On effectiveness<br/>and features
      On Automatic creation
        Uses
            Creative techniques
            Strategic planning
            Argument mapping
    Tools
      Pen and paper
      Mermaid`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/mindmap.md',
  },
  {
    id: 'packet',
    diagramType: 'packet',
    source: `---
title: "TCP Packet"
---
packet
0-15: "Source Port"
16-31: "Destination Port"
32-63: "Sequence Number"
64-95: "Acknowledgment Number"
96-99: "Data Offset"
100-105: "Reserved"
106: "URG"
107: "ACK"
108: "PSH"
109: "RST"
110: "SYN"
111: "FIN"
112-127: "Window"
128-143: "Checksum"
144-159: "Urgent Pointer"
160-191: "(Options and Padding)"
192-255: "Data (variable length)"`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/packet.md',
  },
  {
    id: 'pie-title-pets-adopted-by-volunteers',
    diagramType: 'pie',
    source: `pie title Pets adopted by volunteers
    "Dogs" : 386
    "Cats" : 85
    "Rats" : 15`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/pie.md',
  },
  {
    id: 'pie-showdata',
    diagramType: 'pie',
    source: `---
config:
  pie:
    textPosition: 0.5
    donutHole: 0.2
    highlightSlice: Potassium
  themeVariables:
    pieOuterStrokeWidth: "5px"
---
pie showData
    title Key elements in Product X
    "Calcium" : 42.96
    "Potassium" : 50.05
    "Magnesium" : 10.01
    "Iron" :  5`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/pie.md',
  },
  {
    id: 'quadrantchart',
    diagramType: 'quadrantChart',
    source: `quadrantChart
    title Reach and engagement of campaigns
    x-axis Low Reach --> High Reach
    y-axis Low Engagement --> High Engagement
    quadrant-1 We should expand
    quadrant-2 Need to promote
    quadrant-3 Re-evaluate
    quadrant-4 May be improved
    Campaign A: [0.3, 0.6]
    Campaign B: [0.45, 0.23]
    Campaign C: [0.57, 0.69]
    Campaign D: [0.78, 0.34]
    Campaign E: [0.40, 0.34]
    Campaign F: [0.35, 0.78]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/quadrantChart.md',
  },
  {
    id: 'radar-beta',
    diagramType: 'radar',
    source: `---
title: "Grades"
---
radar-beta
  axis m["Math"], s["Science"], e["English"]
  axis h["History"], g["Geography"], a["Art"]
  curve a["Alice"]{85, 90, 80, 70, 75, 90}
  curve b["Bob"]{70, 75, 85, 80, 90, 85}

  max 100
  min 0`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/radar.md',
  },
  {
    id: 'railroad-ebnf-beta',
    diagramType: 'railroadEbnf',
    source: `railroad-ebnf-beta
title "Digit Definition"

digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/railroad.md',
  },
  {
    id: 'railroad-abnf-beta',
    diagramType: 'railroadAbnf',
    source: `railroad-abnf-beta
title "Email Address"

address = local-part "@" domain ;
local-part = 1*( ALPHA / DIGIT / "." / "-" ) ;
domain = label *( "." label ) ;
label = 1*( ALPHA / DIGIT / "-" ) ;`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/railroad.md',
  },
  {
    id: 'railroad-peg-beta',
    diagramType: 'railroadPeg',
    source: `railroad-peg-beta
title "Calculator Grammar"

Expression <- Term (("+" / "-") Term)* ;
Term <- Factor (("*" / "/") Factor)* ;
Factor <- Number / "(" Expression ")" ;
Number <- Digit+ ;
Digit <- "0" / "1" / "2" / "3" / "4" / "5" / "6" / "7" / "8" / "9" ;`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/railroad.md',
  },
  {
    id: 'railroad-beta',
    diagramType: 'railroad',
    source: `railroad-beta
title Expression Grammar

expression = sequence(
    nonterminal("term"),
    zeroOrMore(sequence(
        choice(terminal("+"), terminal("-")),
        nonterminal("term")
    ))
) ;
term = sequence(
    nonterminal("factor"),
    zeroOrMore(sequence(
        choice(terminal("*"), terminal("/")),
        nonterminal("factor")
    ))
) ;
factor = choice(
    nonterminal("number"),
    sequence(terminal("("), nonterminal("expression"), terminal(")"))
) ;
number = oneOrMore(nonterminal("digit")) ;
digit = choice(terminal("0"), terminal("1"), terminal("2"), terminal("3"), terminal("4"), terminal("5"), terminal("6"), terminal("7"), terminal("8"), terminal("9")) ;`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/railroad.md',
  },
  {
    id: 'requirementdiagram',
    diagramType: 'requirement',
    source: `requirementDiagram

    requirement test_req {
    id: 1
    text: the test text.
    risk: high
    verifymethod: test
    }

    element test_entity {
    type: simulation
    }

    test_entity - satisfies -> test_req`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/requirementDiagram.md',
  },
  {
    id: 'sankey',
    diagramType: 'sankey',
    source: `---
config:
  sankey:
    showValues: false
---
sankey

Agricultural 'waste',Bio-conversion,124.729
Bio-conversion,Liquid,0.597
Bio-conversion,Losses,26.862
Bio-conversion,Solid,280.322
Bio-conversion,Gas,81.144
Biofuel imports,Liquid,35
Biomass imports,Solid,35
Coal imports,Coal,11.606
Coal reserves,Coal,63.965
Coal,Solid,75.571
District heating,Industry,10.639
District heating,Heating and cooling - commercial,22.505
District heating,Heating and cooling - homes,46.184
Electricity grid,Over generation / exports,104.453
Electricity grid,Heating and cooling - homes,113.726
Electricity grid,H2 conversion,27.14
Electricity grid,Industry,342.165
Electricity grid,Road transport,37.797
Electricity grid,Agriculture,4.412
Electricity grid,Heating and cooling - commercial,40.858
Electricity grid,Losses,56.691
Electricity grid,Rail transport,7.863
Electricity grid,Lighting & appliances - commercial,90.008
Electricity grid,Lighting & appliances - homes,93.494
Gas imports,Ngas,40.719
Gas reserves,Ngas,82.233
Gas,Heating and cooling - commercial,0.129
Gas,Losses,1.401
Gas,Thermal generation,151.891
Gas,Agriculture,2.096
Gas,Industry,48.58
Geothermal,Electricity grid,7.013
H2 conversion,H2,20.897
H2 conversion,Losses,6.242
H2,Road transport,20.897
Hydro,Electricity grid,6.995
Liquid,Industry,121.066
Liquid,International shipping,128.69
Liquid,Road transport,135.835
Liquid,Domestic aviation,14.458
Liquid,International aviation,206.267
Liquid,Agriculture,3.64
Liquid,National navigation,33.218
Liquid,Rail transport,4.413
Marine algae,Bio-conversion,4.375
Ngas,Gas,122.952
Nuclear,Thermal generation,839.978
Oil imports,Oil,504.287
Oil reserves,Oil,107.703
Oil,Liquid,611.99
Other waste,Solid,56.587
Other waste,Bio-conversion,77.81
Pumped heat,Heating and cooling - homes,193.026
Pumped heat,Heating and cooling - commercial,70.672
Solar PV,Electricity grid,59.901
Solar Thermal,Heating and cooling - homes,19.263
Solar,Solar Thermal,19.263
Solar,Solar PV,59.901
Solid,Agriculture,0.882
Solid,Thermal generation,400.12
Solid,Industry,46.477
Thermal generation,Electricity grid,525.531
Thermal generation,Losses,787.129
Thermal generation,District heating,79.329
Tidal,Electricity grid,9.452
UK land based bioenergy,Bio-conversion,182.01
Wave,Electricity grid,19.013
Wind,Electricity grid,289.366`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/sankey.md',
  },
  {
    id: 'sequencediagram',
    diagramType: 'sequence',
    source: `sequenceDiagram
    Alice->>John: Hello John, how are you?
    John-->>Alice: Great!
    Alice-)John: See you later!`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/sequenceDiagram.md',
  },
  {
    id: 'statediagram-v2',
    diagramType: 'stateDiagram',
    source: `---
title: Simple sample
---
stateDiagram-v2
    [*] --> Still
    Still --> [*]

    Still --> Moving
    Moving --> Still
    Moving --> Crash
    Crash --> [*]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/stateDiagram.md',
  },
  {
    id: 'statediagram',
    diagramType: 'stateDiagram',
    source: `stateDiagram
    [*] --> Still
    Still --> [*]

    Still --> Moving
    Moving --> Still
    Moving --> Crash
    Crash --> [*]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/stateDiagram.md',
  },
  {
    id: 'swimlane-beta-lr',
    diagramType: 'swimlane',
    source: `swimlane-beta LR
  subgraph Customer
    request[Request service]
    receive[Receive update]
  end

  subgraph Support
    triage[Triage request]
    answer[Send answer]
  end

  subgraph Engineering
    investigate[Investigate issue]
    fix[Prepare fix]
  end

  request --> triage
  triage -->|Known issue| answer
  triage -->|Needs code change| investigate
  investigate --> fix --> answer
  answer --> receive`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/swimlanes.md',
  },
  {
    id: 'swimlane-beta',
    diagramType: 'swimlane',
    source: `swimlane-beta
  subgraph Sales
    lead[Qualify lead]
    quote[Prepare quote]
  end`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/swimlanes.md',
  },
  {
    id: 'swimlane-beta-tb',
    diagramType: 'swimlane',
    source: `swimlane-beta TB
  subgraph Intake
    collect[Collect request]
    validate[Validate details]
  end

  subgraph Review
    review[Review request]
    decide{Ready?}
  end

  subgraph Delivery
    schedule[Schedule work]
    complete[Complete work]
  end

  collect --> validate --> review --> decide
  decide -->|Yes| schedule --> complete
  decide -->|No| collect`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/swimlanes.md',
  },
  {
    id: 'timeline',
    diagramType: 'timeline',
    source: `timeline
    title History of Social Media Platform
    2002 : LinkedIn
    2004 : Facebook
         : Google
    2005 : YouTube
    2006 : Twitter`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/timeline.md',
  },
  {
    id: 'timeline-td',
    diagramType: 'timeline',
    source: `timeline TD
  title MermaidChart 2023 Timeline
    section 2023 Q1 <br> Release Personal Tier
      Bullet 1 : sub-point 1a : sub-point 1b
      Bullet 2 : sub-point 2a : sub-point 2b
    section 2023 Q2 <br> Release XYZ Tier
      Bullet 3 : sub-point <br> 3a : sub-point 3b
      Bullet 4 : sub-point 4a : sub-point 4b`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/timeline.md',
  },
  {
    id: 'treeview-beta',
    diagramType: 'treeView',
    source: `treeView-beta
├── src/
│   ├── index.ts
│   └── utils.ts
├── package.json
└── README.md`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/treeView.md',
  },
  {
    id: 'treemap-beta',
    diagramType: 'treemap',
    source: `treemap-beta
"Category A"
    "Item A1": 10
    "Item A2": 20
"Category B"
    "Item B1": 15
    "Item B2": 25`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/treemap.md',
  },
  {
    id: 'journey',
    diagramType: 'journey',
    source: `journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/userJourney.md',
  },
  {
    id: 'venn-beta',
    diagramType: 'venn',
    source: `venn-beta
  title "Team overlap"
  set Frontend
  set Backend
  union Frontend,Backend["APIs"]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/venn.md',
  },
  {
    id: 'wardley-beta',
    diagramType: 'wardley',
    source: `wardley-beta
title Tea Shop Value Chain

anchor Business [0.95, 0.63]
component Cup of Tea [0.79, 0.61]
component Tea [0.63, 0.81]
component Hot Water [0.52, 0.80]
component Kettle [0.43, 0.35]
component Power [0.10, 0.70]

Business -> Cup of Tea
Cup of Tea -> Tea
Cup of Tea -> Hot Water
Hot Water -> Kettle
Kettle -> Power

evolve Kettle 0.62
evolve Power 0.89

note "Standardising power allows Kettles to evolve faster" [0.30, 0.49]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/wardley.md',
  },
  {
    id: 'xychart',
    diagramType: 'xychart',
    source: `xychart
    title "Sales Revenue"
    x-axis [jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]
    line [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/xyChart.md',
  },
  {
    id: 'xychart-beta',
    diagramType: 'xychart',
    source: `xychart-beta
  title "An Example Chart"
  x-axis ["90d", "60d", "30d", "7d", "1d", "Current"]
  y-axis "Seconds" 0 --> 198.2
  line "avg" [48.1, 41.5, 45.7, 72.8, 67.7, 59.9]
  line "p50" [38.2, 36.8, 39.7, 54.5, 49.0, 38.4]
  line "p95" [112.2, 75.3, 103.0, 177.0, 180.2, 109.4]`,
    sourceUrl:
      'https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4011.17.2/packages/mermaid/src/docs/syntax/xyChart.md',
  },
  {
    id: 'info',
    diagramType: 'info',
    source: `info`,
    sourceUrl:
      'https://github.com/mermaid-js/mermaid/blob/mermaid%4011.17.2/packages/mermaid/src/diagrams/info/infoDetector.ts',
  },
];
