import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import { Governance, ProgramAccount, serializeInstructionToBase64 } from '@solana/spl-governance'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { validateInstruction } from '@utils/instructionTools'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { NewProposalContext } from '../../../new'
import GovernedAccountSelect from '../../GovernedAccountSelect'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { useLegacyVoterWeight } from '@hooks/queries/governancePower'
import TokenMintInput from '@components/inputs/TokenMintInput'
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { isFormValid, validatePubkey } from '@utils/formValidation'
import Input from '@components/inputs/Input'
import { WhirlpoolContext, buildWhirlpoolClient } from '@orca-so/whirlpools-sdk'
import Decimal from 'decimal.js'

// Form interface for the component
interface OrcaOpenPositionForm {
  governedAccount?: any // Using any temporarily to fix type errors
  tokenMintA?: string
  tokenMintB?: string
  amount?: string
  whirlpoolConfig?: string
}

const OrcaOpenPosition = ({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) => {
  const connection = useLegacyConnectionContext()
  const wallet = useWalletOnePointOh()
  const { result: ownVoterWeight } = useLegacyVoterWeight()
  const { assetAccounts } = useGovernanceAssets()
  const shouldBeGoverned = !!(index !== 0 && governance)
  
  const [form, setForm] = useState<OrcaOpenPositionForm>({})
  const [formErrors, setFormErrors] = useState({})
  const { handleSetInstructions } = useContext(NewProposalContext)

  const handleSetForm = ({ propertyName, value }) => {
    setFormErrors({})
    setForm({ ...form, [propertyName]: value })
  }

  // Default Orca WhirlpoolsConfig if not provided
  const DEFAULT_WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ')

  // Schema for form validation
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governed account is required'),
    tokenMintA: yup
      .string()
      .test(validatePubkey)
      .required('Token Mint A is required'),
    tokenMintB: yup
      .string()
      .test(validatePubkey)
      .required('Token Mint B is required'),
    amount: yup
      .string()
      .required('Amount is required'),
    whirlpoolConfig: yup
      .string()
      .test(validatePubkey)
      .notRequired()
  })

  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    
    if (!connection || !isValid || !form.governedAccount?.governance?.account || !form.tokenMintA || !form.tokenMintB || !form.amount || !wallet?.publicKey) {
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      }
    }

    try {
      // The ORCA program ID 
      const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')
      
      // Create a compatible wallet adapter
      const walletAdapter = {
        publicKey: wallet.publicKey!,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions
      }
      
      // Create WhirlpoolContext using the from method as shown in the context.d.ts
      const ctx = WhirlpoolContext.from(
        connection.current,
        walletAdapter,
        ORCA_WHIRLPOOL_PROGRAM_ID
      )
      
      // Build client
      const client = buildWhirlpoolClient(ctx)
      
      // Use default config if not provided
      const whirlpoolConfig = form.whirlpoolConfig 
        ? new PublicKey(form.whirlpoolConfig) 
        : DEFAULT_WHIRLPOOLS_CONFIG
      
      // Convert amount to price (in this case using as initial price)
      const initialPrice = new Decimal(form.amount)
      
      // Create splash pool transaction
      const { tx } = await client.createSplashPool(
        whirlpoolConfig, 
        new PublicKey(form.tokenMintA),
        new PublicKey(form.tokenMintB),
        initialPrice,
        form.governedAccount.governance.pubkey
      )
      
      // Get the transaction and serialize it
      const instruction = tx.build()[0].instructions[0]
      
      return {
        serializedInstruction: serializeInstructionToBase64(instruction),
        isValid: true,
        governance: form.governedAccount.governance,
      }
      
    } catch (error) {
      console.error('Error creating SplashPool instruction:', error)
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
      index,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  return (
    <>
      <GovernedAccountSelect
        label="Wallet"
        governedAccounts={assetAccounts.filter(
          (x) => ownVoterWeight?.canCreateProposal(x.governance.account.config),
        )}
        onChange={(value) => {
          handleSetForm({ value, propertyName: 'governedAccount' })
        }}
        value={form.governedAccount}
        error={formErrors['governedAccount']}
        shouldBeGoverned={shouldBeGoverned}
        governance={governance}
      />
      
      <TokenMintInput
        label="Token Mint A"
        onValidMintChange={(mintAddress) => {
          handleSetForm({
            value: mintAddress,
            propertyName: 'tokenMintA',
          })
        }}
        error={formErrors['tokenMintA']}
      />
      
      <TokenMintInput
        label="Token Mint B"
        onValidMintChange={(mintAddress) => {
          handleSetForm({
            value: mintAddress,
            propertyName: 'tokenMintB',
          })
        }}
        error={formErrors['tokenMintB']}
      />
      
      <Input
        label="Initial Price"
        value={form.amount}
        type="number"
        min="0"
        onChange={(e) => {
          handleSetForm({
            value: e.target.value,
            propertyName: 'amount',
          })
        }}
        error={formErrors['amount']}
      />
      
      <TokenMintInput
        label="Whirlpool Config (Optional)"
        onValidMintChange={(mintAddress) => {
          handleSetForm({
            value: mintAddress,
            propertyName: 'whirlpoolConfig',
          })
        }}
        error={formErrors['whirlpoolConfig']}
      />
    </>
  )
}

export default OrcaOpenPosition
