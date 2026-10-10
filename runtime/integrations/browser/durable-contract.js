export function browserOperationHistory(tx) {
    return tx.history ?? { operation: id => Object.hasOwn(tx.ledger.operations, id) ? tx.ledger.operations[id] : null };
}
