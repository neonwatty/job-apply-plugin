export function workflowHistory(tx) {
    return tx.history ?? {
        task: id => Object.hasOwn(tx.ledger.tasks, id) ? tx.ledger.tasks[id] : null,
        receipt: id => Object.hasOwn(tx.ledger.receipts, id) ? tx.ledger.receipts[id] : null,
    };
}
