namespace Nix.Domain.Finance;

/// <summary>Which figure a month is read with.</summary>
public enum FigureSource
{
    /// <summary>What was planned.</summary>
    Plan = 0,

    /// <summary>What the transactions say.</summary>
    Actual = 1,

    /// <summary>Actual for a closed month, plan for an open one.</summary>
    Auto = 2,
}

/// <summary>Income, what left the bank this month, and what went on cards to leave next month.</summary>
public sealed record MonthFigures(decimal Income, decimal PaidThisMonth, decimal CardSpend)
{
    public decimal Outgoings => PaidThisMonth + CardSpend;
    public decimal Net => Income - Outgoings;

    public static readonly MonthFigures Zero = new(0, 0, 0);
}

/// <summary>
/// Everything a finance root holds, in memory, with the totals every calculator asks for.
/// </summary>
/// <remarks>
/// <para>
/// <b>Built once per request from the items, then asked questions.</b> The calculators are pure
/// functions over this, so a budget grid, a cash-flow projection and a dashboard all read the
/// same figures and cannot disagree with each other.
/// </para>
/// <para>
/// <b>A transaction's amount is its cash effect</b>, negative when money left. A spending line's
/// actual is therefore the negation of its transactions' sum, and an income line's is the sum
/// itself, so both read as positive amounts of the thing the line is for.
/// </para>
/// </remarks>
public sealed class FinanceBook
{
    private readonly ILookup<Guid, BudgetLine> _linesByAccount;
    private readonly Dictionary<(Guid? Line, YearMonth Month), (decimal Sum, int Count)> _byLineMonth = [];
    private readonly Dictionary<(Guid Account, YearMonth Month), decimal> _unassignedOutflowByAccountMonth = [];
    private readonly Dictionary<(Guid Account, YearMonth Month), decimal> _unassignedCardCreditByAccountMonth = [];
    private readonly Dictionary<(Guid Account, YearMonth Month), decimal> _unassignedInflowByAccountMonth = [];
    private readonly Dictionary<(Guid Account, YearMonth Month), int> _unassignedCountByAccountMonth = [];
    private readonly HashSet<YearMonth> _closed;

    public FinanceBook(
        FinanceSettings settings,
        IReadOnlyList<FinanceAccount> accounts,
        IReadOnlyList<BudgetLine> lines,
        IReadOnlyList<FinanceTransaction> transactions,
        IEnumerable<YearMonth> closedMonths)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(accounts);
        ArgumentNullException.ThrowIfNull(lines);
        ArgumentNullException.ThrowIfNull(transactions);
        ArgumentNullException.ThrowIfNull(closedMonths);
        Settings = settings;
        Accounts = accounts;
        Lines = lines.OrderBy(line => line.Position).ToList();
        _linesByAccount = Lines.ToLookup(line => line.AccountId);
        Transactions = transactions;
        AccountsById = accounts.ToDictionary(account => account.Id);
        LinesById = Lines.ToDictionary(line => line.Id);
        _closed = [.. closedMonths];
        foreach (var transaction in transactions)
        {
            var month = transaction.Month;
            var line = transaction.LineId is { } lineId && LinesById.ContainsKey(lineId) ? lineId : (Guid?)null;
            _byLineMonth.TryGetValue((line, month), out var running);
            _byLineMonth[(line, month)] = (running.Sum + transaction.Amount, running.Count + 1);
            if (line is null)
            {
                _unassignedCountByAccountMonth.TryGetValue((transaction.AccountId, month), out var unassigned);
                _unassignedCountByAccountMonth[(transaction.AccountId, month)] = unassigned + 1;
                if (transaction.Amount < 0)
                {
                    _unassignedOutflowByAccountMonth.TryGetValue((transaction.AccountId, month), out var @out);
                    _unassignedOutflowByAccountMonth[(transaction.AccountId, month)] = @out - transaction.Amount;
                }
                else if (AccountsById.TryGetValue(transaction.AccountId, out var account) && account.IsCreditCard)
                {
                    // A positive unassigned card transaction is a refund or other card credit.
                    // It reduces the statement balance; it is not money paid into the bank.
                    _unassignedCardCreditByAccountMonth.TryGetValue((transaction.AccountId, month), out var credit);
                    _unassignedCardCreditByAccountMonth[(transaction.AccountId, month)] = credit + transaction.Amount;
                }
                else
                {
                    _unassignedInflowByAccountMonth.TryGetValue((transaction.AccountId, month), out var @in);
                    _unassignedInflowByAccountMonth[(transaction.AccountId, month)] = @in + transaction.Amount;
                }
            }
        }
    }

    public FinanceSettings Settings { get; }
    public IReadOnlyList<FinanceAccount> Accounts { get; }
    public IReadOnlyList<BudgetLine> Lines { get; }
    public IReadOnlyList<FinanceTransaction> Transactions { get; }
    public IReadOnlyDictionary<Guid, FinanceAccount> AccountsById { get; }
    public IReadOnlyDictionary<Guid, BudgetLine> LinesById { get; }

    public IEnumerable<YearMonth> ClosedMonths => _closed.OrderBy(month => month);

    public bool IsClosed(YearMonth month) => _closed.Contains(month);

    /// <summary>The planned amount for a line in a month; an archived line plans nothing.</summary>
    public decimal Plan(BudgetLine line, YearMonth month)
    {
        ArgumentNullException.ThrowIfNull(line);
        return line.Archived ? 0 : line.PlanFor(month, AccountsById);
    }

    /// <summary>What the transactions say a line came to in a month, as a positive amount of its flow.</summary>
    public decimal Actual(BudgetLine line, YearMonth month)
    {
        ArgumentNullException.ThrowIfNull(line);
        var sum = _byLineMonth.TryGetValue((line.Id, month), out var figure) ? figure.Sum : 0;
        return line.IsIncome ? sum : -sum;
    }

    public int TransactionCount(BudgetLine line, YearMonth month)
    {
        ArgumentNullException.ThrowIfNull(line);
        return _byLineMonth.TryGetValue((line.Id, month), out var figure) ? figure.Count : 0;
    }

    public decimal Figure(BudgetLine line, YearMonth month, FigureSource source) => source switch
    {
        FigureSource.Plan => Plan(line, month),
        FigureSource.Actual => Actual(line, month),
        _ => IsClosed(month) ? Actual(line, month) : Plan(line, month),
    };

    /// <summary>Money that left with no budget line, in a month, on every account.</summary>
    public decimal UnassignedOutflow(YearMonth month) =>
        _unassignedOutflowByAccountMonth.Where(pair => pair.Key.Month == month).Sum(pair => pair.Value);

    public decimal UnassignedOutflow(Guid accountId, YearMonth month) =>
        _unassignedOutflowByAccountMonth.TryGetValue((accountId, month), out var amount) ? amount : 0;

    /// <summary>Refunds and other unassigned credits that reduce one card's statement in a month.</summary>
    public decimal UnassignedCardCredit(Guid accountId, YearMonth month) =>
        _unassignedCardCreditByAccountMonth.TryGetValue((accountId, month), out var amount) ? amount : 0;

    public decimal UnassignedInflow(YearMonth month) =>
        _unassignedInflowByAccountMonth.Where(pair => pair.Key.Month == month).Sum(pair => pair.Value);

    public decimal UnassignedInflow(Guid accountId, YearMonth month) =>
        _unassignedInflowByAccountMonth.TryGetValue((accountId, month), out var amount) ? amount : 0;

    public int UnassignedCount(YearMonth month) =>
        _byLineMonth.TryGetValue((null, month), out var figure) ? figure.Count : 0;

    public int UnassignedCount(Guid accountId, YearMonth month) =>
        _unassignedCountByAccountMonth.TryGetValue((accountId, month), out var count) ? count : 0;

    /// <summary>The lines paid into or from one account, in line order.</summary>
    public IEnumerable<BudgetLine> LinesOn(Guid accountId) => _linesByAccount[accountId];

    /// <summary>Whether a spending line's money goes on a card, to be collected next month.</summary>
    public bool OnCard(BudgetLine line)
    {
        ArgumentNullException.ThrowIfNull(line);
        return AccountsById.TryGetValue(line.AccountId, out var account) && account.IsCreditCard;
    }

    /// <summary>What went on one card in a month.</summary>
    public decimal CardSpend(FinanceAccount card, YearMonth month, FigureSource source)
    {
        ArgumentNullException.ThrowIfNull(card);
        var resolved = Resolve(source, month);
        var lines = _linesByAccount[card.Id].Where(line => !line.IsIncome).Sum(line => Figure(line, month, resolved));
        return resolved == FigureSource.Actual
            ? lines + UnassignedOutflow(card.Id, month) - UnassignedCardCredit(card.Id, month)
            : lines;
    }

    /// <summary>The month's headline figures from one source.</summary>
    public MonthFigures Figures(YearMonth month, FigureSource source) => Figures(month, source, null);

    /// <summary>
    /// The month's headline figures from one source, on every account or on one of them. One
    /// account's figures count only the lines it pays and the unassigned money that moved on it, so
    /// they add up across accounts to the whole month's.
    /// </summary>
    public MonthFigures Figures(YearMonth month, FigureSource source, Guid? accountId)
    {
        var resolved = Resolve(source, month);
        decimal income = 0, paid = 0, cards = 0;
        foreach (var line in accountId is { } only ? LinesOn(only) : Lines)
        {
            var figure = Figure(line, month, resolved);
            if (line.IsIncome)
            {
                income += figure;
            }
            else if (OnCard(line))
            {
                cards += figure;
            }
            else
            {
                paid += figure;
            }
        }
        if (resolved == FigureSource.Actual)
        {
            foreach (var account in accountId is { } chosen ? Accounts.Where(account => account.Id == chosen) : Accounts)
            {
                income += UnassignedInflow(account.Id, month);
                var unassigned = UnassignedOutflow(account.Id, month);
                if (account.IsCreditCard)
                {
                    cards += unassigned - UnassignedCardCredit(account.Id, month);
                }
                else
                {
                    paid += unassigned;
                }
            }
        }
        return new MonthFigures(income, paid, cards);
    }

    /// <summary>Which source <see cref="FigureSource.Auto"/> comes down to for a month.</summary>
    public FigureSource Resolve(FigureSource source, YearMonth month) =>
        source == FigureSource.Auto ? (IsClosed(month) ? FigureSource.Actual : FigureSource.Plan) : source;

    /// <summary>The credit cards, in account order.</summary>
    public IEnumerable<FinanceAccount> Cards => Accounts.Where(account => account.IsCreditCard && !account.Archived);

    /// <summary>The loans, in account order.</summary>
    public IEnumerable<FinanceAccount> Loans => Accounts.Where(account => account.IsLoan && !account.Archived);
}
