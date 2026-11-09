export async function createCustomerAccount(prismaClient, actorId, { accountNumber, accountType, holderUserId }) {
  const [account] = await prismaClient.$queryRaw`
    SELECT *
      FROM public.create_customer_account(
        ${actorId}::uuid,
        ${accountNumber}::text,
        ${accountType}::public."AccountType",
        ${holderUserId}::uuid
      )
  `;
  return account;
}

export function isDuplicateAccountNumber(error) {
  if (error?.code === 'P2002') {
    const target = error.meta?.target;
    return !target || (Array.isArray(target)
      ? target.includes('accountNumber')
      : String(target).includes('accountNumber'));
  }

  const driverCause = error?.meta?.driverAdapterError?.cause;
  return (error?.meta?.code === '23505' || error?.cause?.code === '23505')
    || (driverCause?.originalCode === '23505'
      && driverCause?.constraint?.index === 'Account_accountNumber_key');
}

export function getAccountFunctionSqlState(error) {
  return error?.meta?.driverAdapterError?.cause?.originalCode
    ?? error?.meta?.code
    ?? error?.cause?.code;
}

export function safeAccount(account) {
  return {
    id: account.id,
    accountNumber: account.accountNumber,
    type: account.type,
    status: account.status,
    currencyCode: account.currencyCode,
    createdAt: account.createdAt,
  };
}
