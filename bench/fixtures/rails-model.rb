require 'active_support/concern'
require_relative '../lib/authentication'

module Authenticatable
  extend ActiveSupport::Concern

  included do
    before_action :authenticate_user!
    helper_method :current_user
  end

  def current_user
    @current_user ||= User.find_by(id: session[:user_id])
  end

  def authenticate_user!
    redirect_to login_path unless current_user
  end
end

class User < ApplicationRecord
  include Authenticatable

  belongs_to :organization
  has_many :projects, dependent: :destroy
  has_many :comments, dependent: :destroy
  has_many :notifications, as: :recipient

  validates :email, presence: true, uniqueness: { case_sensitive: false }
  validates :name, presence: true, length: { minimum: 2, maximum: 100 }

  scope :active, -> { where(deactivated_at: nil) }
  scope :admins, -> { where(role: 'admin') }
  scope :recently_active, -> { where('last_sign_in_at > ?', 30.days.ago) }

  encrypts :api_token

  before_save :normalize_email

  def full_name
    "#{first_name} #{last_name}".strip
  end

  def admin?
    role == 'admin'
  end

  def deactivate!
    update!(deactivated_at: Time.current, api_token: nil)
  end

  def active?
    deactivated_at.nil?
  end

  private

  def normalize_email
    self.email = email.downcase.strip
  end
end

def self.create_default_admin(org)
  User.create!(
    name: 'Admin',
    email: "admin@#{org.slug}.example.com",
    role: 'admin',
    organization: org
  )
end
