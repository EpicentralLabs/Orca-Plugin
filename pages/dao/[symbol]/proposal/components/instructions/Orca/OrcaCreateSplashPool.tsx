import { useContext, useEffect, useState, useMemo } from 'react'
import * as yup from 'yup'
import { Governance, ProgramAccount, serializeInstructionToBase64 } from '@solana/spl-governance'
import { PublicKey } from '@solana/web3.js'
import { isFormValid, validatePubkey } from '@utils/formValidation'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { NewProposalContext } from '../../../new'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { useLegacyVoterWeight } from '@hooks/queries/governancePower'
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { WhirlpoolContext, buildWhirlpoolClient } from '@orca-so/whirlpools-sdk'
import Decimal from 'decimal.js'
import InstructionForm, { InstructionInput } from '../FormCreator'
import { InstructionInputType } from '../inputInstructionType'
import { AssetAccount } from '@utils/uiTypes/assets'
import tokenPriceService from '@utils/services/tokenPrice'
import { abbreviateAddress } from '@utils/formatting'

// Form interface for the component
interface OrcaCreateSplashPoolForm {
  governedAccount?: AssetAccount | null
  tokenMintA?: { name: string; value: string } | null
  tokenMintB?: { name: string; value: string } | null
  initialPrice?: string
}

const OrcaCreateSplashPool = ({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) => {
  const connection = useLegacyConnectionContext()
  const wallet = useWalletOnePointOh()
  const { assetAccounts, governedTokenAccountsWithoutNfts } = useGovernanceAssets()
  const shouldBeGoverned = !!(index !== 0 && governance)
  
  const [form, setForm] = useState<OrcaCreateSplashPoolForm>({
    governedAccount: null,
    tokenMintA: null,
    tokenMintB: null,
    initialPrice: '',
  })
  const [formErrors, setFormErrors] = useState({})
  const { handleSetInstructions } = useContext(NewProposalContext)

  // Default Orca WhirlpoolsConfig on mainnet
  const DEFAULT_WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ')
  
  // Orca Whirlpool Program ID
  const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')

  // Schema for form validation
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governed account is required'),
    tokenMintA: yup
      .object()
      .nullable()
      .required('Token Mint A is required'),
    tokenMintB: yup
      .object()
      .nullable()
      .required('Token Mint B is required'),
    initialPrice: yup
      .string()
      .required('Initial price is required')
  })

  // Get token options from the selected governance account
  const tokenOptions = useMemo(() => {
    if (!form.governedAccount) return []

    const governedTokenAccounts = governedTokenAccountsWithoutNfts.filter(
      (account) => account.governance.pubkey.equals(form.governedAccount?.governance?.pubkey || new PublicKey(''))
    )
    
    return governedTokenAccounts.map((account) => {
      const mintAddress = account.extensions.mint?.publicKey.toBase58() || ''
      const tokenInfo = tokenPriceService.getTokenInfo(mintAddress)
      
      return {
        name: tokenInfo?.symbol 
          ? `${tokenInfo.symbol} (${abbreviateAddress(new PublicKey(mintAddress))})`
          : abbreviateAddress(new PublicKey(mintAddress)),
        value: mintAddress
      }
    })
  }, [form.governedAccount, governedTokenAccountsWithoutNfts])

  async function getInstruction(): Promise<UiInstruction> {
    const { isValid, validationErrors } = await isFormValid(schema, form)
    setFormErrors(validationErrors)
    
    if (!connection || !isValid || !form.governedAccount?.governance?.account || !form.tokenMintA?.value || !form.tokenMintB?.value || !form.initialPrice || !wallet?.publicKey) {
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      }
    }

    try {
      // Create a compatible wallet adapter
      const walletAdapter = {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions
      }
      
      // Create WhirlpoolContext
      const ctx = WhirlpoolContext.from(
        connection.current,
        walletAdapter,
        ORCA_WHIRLPOOL_PROGRAM_ID
      )
      
      // Build client
      const client = buildWhirlpoolClient(ctx)
      
      // Always use the default mainnet config
      const whirlpoolConfig = DEFAULT_WHIRLPOOLS_CONFIG
      
      // Convert initialPrice to Decimal type
      const initialPrice = new Decimal(form.initialPrice)
      
      // Create splash pool transaction
      const { tx } = await client.createSplashPool(
        whirlpoolConfig, 
        new PublicKey(form.tokenMintA.value),
        new PublicKey(form.tokenMintB.value),
        initialPrice,
        form.governedAccount.governance.pubkey
      )
      
      // Get the transaction and serialize it
      const instructions = tx.build()[0].instructions
      
      return {
        serializedInstruction: serializeInstructionToBase64(instructions[0]),
        isValid: true,
        governance: form.governedAccount.governance,
      }
    } catch (error) {
      console.error('Error creating splash pool instruction:', error)
      setFormErrors({
        instruction: 'Error creating instruction: ' + (error instanceof Error ? error.message : String(error))
      })
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      }
    }
  }

  useEffect(() => {
    handleSetInstructions(
      { governedAccount: form.governedAccount?.governance, getInstruction },
      index
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- TODO please fix, it can cause difficult bugs. You might wanna check out https://bobbyhadz.com/blog/react-hooks-exhaustive-deps for info. -@asktree
  }, [form])

  // Define the form inputs
  const inputs: InstructionInput[] = [
    {
      label: 'Governance',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned: shouldBeGoverned,
      governance: governance,
      options: assetAccounts,
    },
    {
      label: 'Token Mint A',
      initialValue: form.tokenMintA,
      name: 'tokenMintA',
      type: InstructionInputType.SELECT,
      options: tokenOptions,
    },
    {
      label: 'Token Mint B',
      initialValue: form.tokenMintB,
      name: 'tokenMintB',
      type: InstructionInputType.SELECT,
      options: tokenOptions,
    },
    {
      label: 'Initial Price (price of Token A in terms of Token B)',
      initialValue: form.initialPrice,
      name: 'initialPrice',
      type: InstructionInputType.INPUT,
      inputType: 'number',
      min: 0,
    }
  ]

  return (
    <>
      {form && (
        <InstructionForm
          outerForm={form}
          setForm={setForm}
          inputs={inputs}
          setFormErrors={setFormErrors}
          formErrors={formErrors}
        />
      )}
      
      {formErrors['instruction'] && (
        <div className="text-red-500 text-sm mt-2">{formErrors['instruction']}</div>
      )}
    </>
  )
}

export default OrcaCreateSplashPool
