import React, { useContext, useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import {
  UiInstruction,
} from '@utils/uiTypes/proposalCreationTypes'
import { NewProposalContext } from '../../../new'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { Governance, serializeInstructionToBase64 } from '@solana/spl-governance'
import { ProgramAccount } from '@solana/spl-governance'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext'
import GovernanceAccountSelect from '../../GovernanceAccountSelect'
import { SplGovernance } from 'governance-idl-sdk'
import Input from '@components/inputs/Input'
import { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID } from "@orca-so/whirlpools-sdk"
import { Decimal } from "decimal.js"
import { AnchorProvider } from "@coral-xyz/anchor"
import { AssetAccount } from '@utils/uiTypes/assets'

const CreateSplashPool = ({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) => {
  const connection = useLegacyConnectionContext()
  const wallet = useWalletOnePointOh()
  const { governancesArray, assetAccounts } = useGovernanceAssets()
  const { handleSetInstructions } = useContext(NewProposalContext)
  
  // State for form inputs
  const [governedAccount, setGovernedAccount] = useState<
    ProgramAccount<Governance> | undefined
  >(undefined)
  const [tokenAssetA, setTokenAssetA] = useState<AssetAccount | null>(null)
  const [tokenAssetB, setTokenAssetB] = useState<AssetAccount | null>(null)
  const [initialPrice, setInitialPrice] = useState<string>('0.01')
  const [isValid, setIsValid] = useState(false)

  // Get tokenAddressA and tokenAddressB from the selected assets
  const tokenAddressA = tokenAssetA?.extensions?.mint?.publicKey?.toBase58() || ''
  const tokenAddressB = tokenAssetB?.extensions?.mint?.publicKey?.toBase58() || ''

  // Initialize SplGovernance to interact with governance program
  const splGovernance = new SplGovernance(connection.current)
  
  // Get the native treasury address for the selected governance account
  const nativeAddress = governedAccount?.pubkey ?
    splGovernance.pda.nativeTreasuryAccount({governanceAccount: governedAccount.pubkey}).publicKey :
    undefined

  // Filter token accounts from governance assets
  const tokenAccounts = assetAccounts.filter(
    (asset) => asset.isToken && asset.extensions.mint
  )

  // Validate form inputs
  useEffect(() => {
    setIsValid(
      !!governedAccount &&
      !!tokenAddressA &&
      !!tokenAddressB &&
      !!initialPrice &&
      !!nativeAddress &&
      !isNaN(parseFloat(initialPrice)) &&
      parseFloat(initialPrice) > 0
    )
  }, [governedAccount, tokenAddressA, tokenAddressB, initialPrice, nativeAddress])

  /**
   * Generates the instruction to create a Splash Pool with Orca
   * @returns Promise resolving to a UiInstruction object
   */
  async function getInstruction(): Promise<UiInstruction> {
    if (
      governedAccount?.account &&
      wallet?.publicKey &&
      nativeAddress &&
      isValid
    ) {
      try {
        // Create a compatible wallet interface for AnchorProvider
        const governanceWallet = {
          publicKey: nativeAddress,
          signTransaction: async () => { throw new Error('Governance wallet cannot sign directly') },
          signAllTransactions: async () => { throw new Error('Governance wallet cannot sign directly') }
        }

        // Create provider with the wallet that matches what the SDK expects
        const provider = new AnchorProvider(
          connection.current,
          governanceWallet,
          AnchorProvider.defaultOptions()
        )

        // Set up WhirlpoolContext with the provider
        const ctx = WhirlpoolContext.withProvider(
          provider,
          ORCA_WHIRLPOOL_PROGRAM_ID
        )
        
        // Get the client - this should be available on the context
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = (ctx as any).getClient()
        
        // Mainnet WhirlpoolsConfig (can be changed for devnet if needed)
        const whirlpoolsConfig = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR")
        const tokenMintA = new PublicKey(tokenAddressA)
        const tokenMintB = new PublicKey(tokenAddressB)
        const price = new Decimal(initialPrice)

        // Generate the transaction to create a splash pool
        // But don't execute it - just get the transaction builder
        const { poolKey, tx } = await client.createSplashPool(
          whirlpoolsConfig,
          tokenMintA,
          tokenMintB,
          price,
          nativeAddress
        )

        // Serialize the instructions for the governance proposal
        const additionalSerializedInstructions = tx.instructions.map(ix => 
          serializeInstructionToBase64(ix)
        )

        return {
          serializedInstruction: '',
          additionalSerializedInstructions,
          isValid: true,
          governance: governedAccount,
          chunkBy: 1,
        }
      } catch (error) {
        console.error('Error creating splash pool instruction:', error)
        return {
          serializedInstruction: '',
          isValid: false,
          governance: governedAccount,
          chunkBy: 1,
        }
      }
    } else {
      return {
        serializedInstruction: '',
        isValid: false,
        governance: governedAccount,
        chunkBy: 1,
      }
    }
  }
  
  // Update the instruction when dependencies change
  useEffect(() => {
    handleSetInstructions(
      { governedAccount: governedAccount, getInstruction },
      index,
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenAddressA, tokenAddressB, initialPrice, governedAccount, isValid, nativeAddress])

  return (
    <>
      <GovernanceAccountSelect
        label="Governance"
        governanceAccounts={governancesArray}
        onChange={setGovernedAccount}
        value={governedAccount}
      />

      <div className="mb-3">
        <label className="block text-sm font-medium text-white/50 mb-1">
          Token A (Select governance token asset)
        </label>
        <select
          className="w-full p-2 bg-bkg-1 rounded-md border border-fgd-4 text-sm focus:outline-none focus:border-primary-light"
          onChange={(e) => {
            const selectedIndex = parseInt(e.target.value)
            if (selectedIndex >= 0) {
              const selectedAsset = tokenAccounts[selectedIndex]
              setTokenAssetA(selectedAsset)
            } else {
              setTokenAssetA(null)
            }
          }}
          value={tokenAccounts.findIndex(
            (x) => x.extensions.mint?.publicKey.toBase58() === tokenAddressA
          )}
        >
          <option value={-1}>Select a token</option>
          {tokenAccounts.map((asset, index) => {
            const mintAddress = asset.extensions.mint?.publicKey.toBase58()
            const shortMint = mintAddress ? `${mintAddress.slice(0, 8)}...` : ''
            return (
              <option key={asset.pubkey.toBase58()} value={index}>
                {shortMint}
              </option>
            )
          })}
        </select>
        {tokenAddressA && (
          <div className="mt-1 text-xs text-white/50">
            Mint: {tokenAddressA}
          </div>
        )}
      </div>

      <div className="mb-3">
        <label className="block text-sm font-medium text-white/50 mb-1">
          Token B (Select governance token asset)
        </label>
        <select
          className="w-full p-2 bg-bkg-1 rounded-md border border-fgd-4 text-sm focus:outline-none focus:border-primary-light"
          onChange={(e) => {
            const selectedIndex = parseInt(e.target.value)
            if (selectedIndex >= 0) {
              const selectedAsset = tokenAccounts[selectedIndex]
              setTokenAssetB(selectedAsset)
            } else {
              setTokenAssetB(null)
            }
          }}
          value={tokenAccounts.findIndex(
            (x) => x.extensions.mint?.publicKey.toBase58() === tokenAddressB
          )}
        >
          <option value={-1}>Select a token</option>
          {tokenAccounts.map((asset, index) => {
            const mintAddress = asset.extensions.mint?.publicKey.toBase58()
            const shortMint = mintAddress ? `${mintAddress.slice(0, 8)}...` : ''
            return (
              <option key={asset.pubkey.toBase58()} value={index}>
                {shortMint}
              </option>
            )
          })}
        </select>
        {tokenAddressB && (
          <div className="mt-1 text-xs text-white/50">
            Mint: {tokenAddressB}
          </div>
        )}
      </div>

      <Input
        label="Initial Price (Token A in terms of Token B)"
        value={initialPrice}
        type="number"
        min="0.000000001"
        onChange={(e) => setInitialPrice(e.target.value)}
        placeholder="Initial Price (e.g., 0.01)"
      />
    </>
  )
}

export default CreateSplashPool
