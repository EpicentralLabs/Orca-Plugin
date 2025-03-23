import { Connection, PublicKey } from '@solana/web3.js'
import { AccountMetaData } from '@solana/spl-governance'
import { useQuery } from '@tanstack/react-query'
import { TOKEN_PROGRAM_ID, AccountLayout, MintLayout } from '@solana/spl-token'
import { getMintDecimalAmountFromNatural } from '@tools/sdk/units'

/** HELPER: fetch a token account */
const fetchTokenAccount = async (connection: Connection, accountPk: PublicKey) => {
  const info = await connection.getAccountInfo(accountPk)
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) return null
  const decoded = AccountLayout.decode(info.data)
  const mint = decoded.mint
  return { ...decoded, mint: new PublicKey(mint) }
}

/** HELPER: fetch a mint account */
const fetchMintInfo = async (connection: Connection, mintPk: PublicKey) => {
  if (!mintPk) return null
  const info = await connection.getAccountInfo(mintPk)
  if (!info) return null
  return MintLayout.decode(info.data)
}

/**
 * This is an object that might help decode/describe instructions.
 * For example, if your Orca program has an ID "OrcaProgram111..."
 * and its "createPool" instruction code is '1', etc.
 */
export const ORCA_INSTRUCTIONS = {
  'OrcaProgram111111111111111111111111111111111': {
    1: {
      name: 'Create Liquidity Pool',
      accounts: [
        { name: 'Token A Mint' },
        { name: 'Token B Mint' },
        { name: 'Pool Authority' },
        { name: 'Fee Account' },
        { name: 'Pool State' },
        { name: 'Token Program' },
      ],
      getDataUI: (
        connection: Connection,
        data: Uint8Array,
        accounts: AccountMetaData[]
      ) => {
        // Example usage of React Query:
        const { data: tokenAInfo } = useQuery(
          ['orca-token-a', accounts[0].pubkey.toBase58()],
          () => fetchTokenAccount(connection, accounts[0].pubkey)
        )
        const { data: tokenBInfo } = useQuery(
          ['orca-token-b', accounts[1].pubkey.toBase58()],
          () => fetchTokenAccount(connection, accounts[1].pubkey)
        )

        // fetch mint info if needed
        const { data: tokenAMintInfo } = useQuery(
          ['orca-mint-a', tokenAInfo?.mint?.toBase58()],
          () => fetchMintInfo(connection, tokenAInfo?.mint),
          { enabled: !!tokenAInfo?.mint }
        )
        const { data: tokenBMintInfo } = useQuery(
          ['orca-mint-b', tokenBInfo?.mint?.toBase58()],
          () => fetchMintInfo(connection, tokenBInfo?.mint),
          { enabled: !!tokenBInfo?.mint }
        )

        // Return UI
        return (
          <div>
            <div>
              <strong>Token A balance:</strong>{' '}
              {tokenAInfo && tokenAMintInfo &&
                getMintDecimalAmountFromNatural(tokenAMintInfo, tokenAInfo.amount).toFormat()
              }
            </div>
            <div>
              <strong>Token B balance:</strong>{' '}
              {tokenBInfo && tokenBMintInfo &&
                getMintDecimalAmountFromNatural(tokenBMintInfo, tokenBInfo.amount).toFormat()
              }
            </div>
          </div>
        )
      },
    },
  },
}
